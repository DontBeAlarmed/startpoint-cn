require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-login-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreSnapshot = () => {}
let restoreTime = () => {}
function cleanup() {
    if (db?.open) db.close()
    restoreSnapshot()
    restoreTime()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
let failReconciliation = false
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "mission-event-login-test" },
    repository: {
        info: () => ({ source: "release", assetVersion: "test", generatorVersion: 1, releaseDigest: "sha256:test" }),
        table: tableName => {
            if (failReconciliation) throw new Error("forced load reconciliation failure")
            if (tableName === "mission_event.json") return require("../assets/mission_event.json")
            if (tableName === "mission_event_reward.json") return require("../assets/mission_event_reward.json")
            return {}
        },
    },
}
restoreSnapshot = () => { productionContentSnapshotProvider.snapshot = previousSnapshot }

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
let failResponseEncoding = false
const cnLoadRoutes = require("../src/routes/cn/load").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
function setServerTime(isoTimestamp) {
    setServerTimeOffset(Date.parse(isoTimestamp) - Date.now())
}

setServerTime("2019-11-27T04:00:00.000Z")
initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-event-login-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerIds = [800000411, 800000412]
for (const viewerId of viewerIds) {
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
}
db.prepare("UPDATE players SET time_offset = ? WHERE id = ?").run(987654321, playerId)

function encodeRequest(body) {
    return pack(body).toString("base64")
}

async function load(fastify, viewerId, deviceId) {
    return fastify.inject({
        method: "POST",
        url: "/load",
        headers: { "content-type": "application/x-www-form-urlencoded", res_ver: "1.4.54" },
        payload: encodeRequest({
            viewer_id: viewerId,
            keychain: viewerId,
            device_id: deviceId,
            device_token: `device-${deviceId}`,
        }),
    })
}

async function main() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(fastify, payload => {
        if (failResponseEncoding) throw new Error("forced load response encoding failure")
        return encodeCnMsgpackPayload(payload)
    })
    await fastify.register(cnLoadRoutes, { assetProvider: { mode: "client-owned" } })
    await fastify.ready()
    try {
        failReconciliation = true
        const failedReconciliation = await load(fastify, viewerIds[0], 101)
        assert.equal(failedReconciliation.statusCode, 500)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225], undefined)
        assert.equal(db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_event_mission_login_days
            WHERE player_id = ? AND mission_id = 1225
        `).get(playerId).count, 0, "reconcile 失败的 load 不得留下登录 marker")
        failReconciliation = false

        failResponseEncoding = true
        const failedEncoding = await load(fastify, viewerIds[0], 101)
        assert.equal(failedEncoding.statusCode, 500)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225], undefined)
        assert.equal(db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_event_mission_login_days
            WHERE player_id = ? AND mission_id = 1225
        `).get(playerId).count, 0, "服务端序列化失败的 load 不得留下登录 marker")
        failResponseEncoding = false

        const first = await load(fastify, viewerIds[0], 101)
        assert.equal(first.statusCode, 200, first.body)
        const repeatedOtherDevice = await load(fastify, viewerIds[1], 202)
        assert.equal(repeatedOtherDevice.statusCode, 200, repeatedOtherDevice.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 1)

        setServerTime("2019-11-27T16:00:00.000Z")
        const nextNaturalDay = await load(fastify, viewerIds[1], 202)
        assert.equal(nextNaturalDay.statusCode, 200, nextNaturalDay.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 2)

        setServerTime("2019-12-20T04:00:00.000Z")
        const afterPeriod = await load(fastify, viewerIds[0], 101)
        assert.equal(afterPeriod.statusCode, 200, afterPeriod.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1225].progress, 2)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053], undefined, "普通 load 不得完成 Raid summary 任务")
    } finally {
        await fastify.close()
    }
}

main().then(
    () => console.log("mission event login route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
).finally(cleanup)
