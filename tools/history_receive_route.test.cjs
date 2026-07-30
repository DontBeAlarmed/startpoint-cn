require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "history-receive-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const historyRoutes = require("../src/routes/api/history").default

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `history-receive-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000298
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

const insertHistory = db.prepare(`
    INSERT INTO players_receive_history
        (player_id, type, type_id, number, reason_id, create_time)
    VALUES (?, 1, ?, 1, 0, ?)
`)
const now = Date.now()
db.transaction(() => {
    for (let index = 1; index <= 205; index++) {
        const createTime = new Date(now - index * 1000)
            .toISOString().replace("T", " ").substring(0, 19)
        insertHistory.run(playerId, index, createTime)
    }
})()

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            const { pack } = require("msgpackr")
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(historyRoutes)
    await fastify.ready()

    try {
        for (const [page, expectedLength, firstTypeId, lastTypeId] of [
            [1, 100, 1, 100],
            [2, 100, 101, 200],
            [3, 5, 201, 205],
        ]) {
            const response = await fastify.inject({
                method: "POST",
                url: "/receive",
                payload: { viewer_id: viewerId, api_count: 1, page },
            })
            assert.equal(response.statusCode, 200, response.body)
            const data = unpack(response.rawPayload).data
            assert.equal(data.history.length, expectedLength)
            assert.equal(data.history[0].type_id, firstTypeId)
            assert.equal(data.history.at(-1).type_id, lastTypeId)
            assert.equal(data.total_count, 205)
        }

        for (const page of [0, -1, 1.5, "1", null]) {
            const response = await fastify.inject({
                method: "POST",
                url: "/receive",
                payload: { viewer_id: viewerId, api_count: 1, page },
            })
            assert.equal(response.statusCode, 400, `page=${String(page)} must fail closed`)
        }
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("history receive route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
