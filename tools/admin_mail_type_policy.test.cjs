"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-mail-type-policy-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerMailsSync, insertMailSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const adminMailRoutes = require("../src/routes/web_api/mail").default
const clientMailRoutes = require("../src/routes/api/mail").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

const CHARACTER_ID = 1
const EQUIPMENT_ID = 3010006
const ITEM_ID = 30005

let app
let viewerId

test.before(async () => {
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `admin-mail-type-policy-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    viewerId = 910000001
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })

    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(adminMailRoutes)
    app.register(clientMailRoutes)
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

async function sendAdminMail(type, overrides = {}) {
    return app.inject({
        method: "POST",
        url: "/send",
        headers: { accept: "application/json" },
        payload: {
            type: String(type),
            number: "1",
            ...overrides,
        },
    })
}

function addMail(playerId, type, typeId, number) {
    return insertMailSync(playerId, {
        reason_id: 0,
        subject: null,
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2024-08-01 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    })
}

test("admin creation exposes only the supported attachment matrix", async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `admin-matrix-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const idByType = {
        1: ITEM_ID,
        5: CHARACTER_ID,
        6: EQUIPMENT_ID,
    }

    for (const type of [1, 4, 5, 6, 7, 8, 9, 10]) {
        const response = await sendAdminMail(type, {
            playerId: String(playerId),
            ...(idByType[type] === undefined ? {} : { type_id: String(idByType[type]) }),
        })
        assert.equal(response.statusCode, 200, `type ${type}: ${response.body}`)
    }

    for (const type of [3, 11, 12, 15]) {
        const response = await sendAdminMail(type, { playerId: String(playerId) })
        assert.equal(response.statusCode, 400, `type ${type}: ${response.body}`)
    }
})

test("mana and exp attachments omit type_id and keep the database shape", async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `admin-empty-id-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id

    for (const type of [MailType.FREE_MANA, MailType.EXP_POOL]) {
        const response = await sendAdminMail(type, { playerId: String(playerId) })
        assert.equal(response.statusCode, 200, response.body)
        const mail = getPlayerMailsSync(playerId, 1, 1)[0]
        assert.equal(mail.type, type)
        assert.equal(mail.type_id, null)
    }
})

test("character and equipment attachments remain single only", async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `admin-single-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id

    for (const [type, typeId] of [[MailType.CHARACTER, CHARACTER_ID], [MailType.EQUIPMENT, EQUIPMENT_ID]]) {
        const response = await sendAdminMail(type, {
            playerId: String(playerId),
            type_id: String(typeId),
            number: "2",
        })
        assert.equal(response.statusCode, 400, response.body)
    }
})

test("historical dedicated mail remains claimable through the client API", async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `historical-claim-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const historicalViewerId = 910000002
    await insertSessionWithToken({
        token: String(historicalViewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    const playerBefore = getPlayerSync(playerId)
    const fixtures = [
        { type: MailType.PAID_VMONEY, field: "vmoney", playerField: "vmoney", amount: 3 },
        { type: MailType.BOSS_BOOST_POINT, field: "boss_boost_point", playerField: "bossBoostPoint", amount: 10 },
        { type: MailType.BOOST_POINT, field: "boost_point", playerField: "boostPoint", amount: 11 },
        { type: MailType.RANK_POINT, field: "rank_point", playerField: "rankPoint", amount: 12 },
    ]
    const mailIds = fixtures.map(fixture => addMail(playerId, fixture.type, null, fixture.amount))

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { api_count: 0, viewer_id: historicalViewerId, mail_ids: mailIds },
    })

    assert.equal(response.statusCode, 200, `receive_all: ${response.body}`)
    const result = unpack(Buffer.from(response.body, "base64")).data
    assert.deepEqual(result.mail_ids, mailIds)
    assert.deepEqual(result.user_info, Object.fromEntries(fixtures.map(fixture => [
        fixture.field,
        playerBefore[fixture.playerField] + fixture.amount,
    ])))
    for (const mailId of mailIds) {
        const mail = getPlayerMailsSync(playerId, 1, 100).find(row => row.id === mailId)
        assert.notEqual(mail.receive_time, "0000-00-00 00:00:00")
    }
})
