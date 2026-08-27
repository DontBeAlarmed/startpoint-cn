"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-mail-expiry-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerMailsSync } = require("../src/data/domains/mail")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const mailRoutes = require("../src/routes/web_api/mail").default

let app
let playerId

test.before(async () => {
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "admin-mail-expiry",
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
    app = Fastify({ logger: false })
    app.register(mailRoutes)
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

async function sendMail(expirationDays) {
    return app.inject({
        method: "POST",
        url: "/send",
        headers: { accept: "application/json" },
        payload: {
            type: "4",
            number: "10",
            playerId: String(playerId),
            ...(expirationDays === undefined ? {} : { expirationDays }),
        },
    })
}

function newestMail() {
    return getPlayerMailsSync(playerId, 1, 1)[0]
}

function parseDatabaseTime(value) {
    return Date.parse(`${value.replace(" ", "T")}Z`)
}

test("admin mail defaults to a 31-day reward period", async () => {
    const response = await sendMail()

    assert.equal(response.statusCode, 200, response.body)
    const mail = newestMail()
    assert.equal(mail.reward_period_limited, 1)
    const durationMs = parseDatabaseTime(mail.reward_limit_time) - parseDatabaseTime(mail.create_time)
    assert.equal(durationMs, 31 * 24 * 60 * 60 * 1000)
})

test("admin mail accepts an explicit reward period in days", async () => {
    const response = await sendMail(7)

    assert.equal(response.statusCode, 200, response.body)
    const mail = newestMail()
    const durationMs = parseDatabaseTime(mail.reward_limit_time) - parseDatabaseTime(mail.create_time)
    assert.equal(durationMs, 7 * 24 * 60 * 60 * 1000)
})

test("admin mail rejects an invalid reward period", async () => {
    const response = await sendMail(0)
    assert.equal(response.statusCode, 400, response.body)
    assert.match(JSON.parse(response.body).error, /有效天数/)
})
