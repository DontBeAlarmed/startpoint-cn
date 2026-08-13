require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-receive-route-db-"))
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

const missionRow = []
missionRow[0] = "99"
missionRow[1] = "1"
missionRow[3] = "route_repository_claim"
missionRow[56] = "(None)"
missionRow[58] = "(None)"
missionRow[60] = "2020-01-01 00:00:00"
missionRow[61] = "(None)"

const eventRow = []
eventRow[2] = "0"
eventRow[3] = "1"
eventRow[14] = "2020-01-01 00:00:00"
eventRow[15] = "(None)"
eventRow[22] = "123"

const rewardRow = []
rewardRow[3] = "1"
rewardRow[4] = "(None)"
rewardRow[7] = "0"
rewardRow[8] = "5"

const tables = {
    "daily_challenge_point_lookup.json": require("../assets/daily_challenge_point_lookup.json"),
    "hard_multi_event.json": {},
    "hard_multi_event_quest.json": {},
    "periodic_reward_point.json": {},
    "mission_regular.json": require("../assets/mission_regular.json"),
    "mission_daily.json": require("../assets/mission_daily.json"),
    "mission_event.json": require("../assets/mission_event.json"),
    "mission_collect_item.json": require("../assets/mission_collect_item.json"),
    "mission_degree.json": require("../assets/mission_degree.json"),
    "mission_char_awake.json": require("../assets/mission_char_awake.json"),
    "mission_weekly_def.json": require("../assets/mission_weekly_def.json"),
    "mission_pass_daily.json": require("../assets/mission_pass_daily.json"),
    "mission_pass_week.json": require("../assets/mission_pass_week.json"),
    "mission_pass_event.json": require("../assets/mission_pass_event.json"),
    "mission_active.json": { 99001: [missionRow] },
    "mission_active_event.json": { 99: [eventRow] },
    "mission_active_reward.json": { 99001: { 1: [rewardRow] } },
}

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "test" },
    repository: {
        info: () => ({
            source: "release",
            assetVersion: "test",
            generatorVersion: 1,
            releaseDigest: "sha256:test",
        }),
        table: tableName => {
            if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
            return tables[tableName]
        },
    },
}
restoreSnapshot = () => {
    productionContentSnapshotProvider.snapshot = previousSnapshot
}

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const activeMissionRoutes = require("../src/routes/api/activeMission").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `active-mission-receive-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000219
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
updatePlayerActiveMissionSync(playerId, 99001, 1)
updatePlayerActiveMissionStageSync(playerId, 1, 99001, false)

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    const fastify = Fastify()
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(activeMissionRoutes, { prefix: "/api/index.php/active_mission" })
    await fastify.ready()

    const request = () => fastify.inject({
        method: "POST",
        url: "/api/index.php/active_mission/receive",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            active_mission_list: [{ mission_id: 99001, stages: [1] }],
        }),
    })

    try {
        const locked = await request()
        assert.equal(locked.statusCode, 400, locked.body)
        assert.equal(JSON.parse(locked.body).message, "Active mission is not available.")
        assert.equal(getPlayerActiveMissionsSync(playerId)[99001].stages[1], false)

        insertPlayerQuestProgressSync(playerId, 1, {
            questId: 123,
            finished: true,
            unlocked: true,
        })
        const vmoneyBefore = getPlayerSync(playerId).freeVmoney
        const unlocked = await request()
        assert.equal(unlocked.statusCode, 200, unlocked.body)
        assert.deepEqual(decodeResponse(unlocked).data.active_mission_list, [{
            mission_id: 99001,
            progress_value: 1,
            stages: [{ stage: 1, received: true }],
        }])
        assert.equal(getPlayerActiveMissionsSync(playerId)[99001].stages[1], true)
        assert.equal(getPlayerSync(playerId).freeVmoney, vmoneyBefore + 5)

        const repeated = await request()
        assert.equal(repeated.statusCode, 200, repeated.body)
        assert.deepEqual(decodeResponse(repeated).data.active_mission_list, [])
        assert.equal(getPlayerSync(playerId).freeVmoney, vmoneyBefore + 5)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("active mission receive route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
