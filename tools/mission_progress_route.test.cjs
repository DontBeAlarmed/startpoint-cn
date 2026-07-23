require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-progress-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreTimeOffset = () => {}

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    restoreTimeOffset()
}

process.once("exit", cleanupDatabase)

stubModule("../src/lib/mission/index", {
    getComputer: () => ({
        buildContext: () => ({}),
        compute: (_missionId, _ctx, dbProgress) => dbProgress,
    }),
    getMissionIdsByCategory: () => [],
    getCurrentStage: () => 0,
    getCharacterIdFromMission: () => "",
    isMissionEnabledAt: () => false,
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
    settleAwakeMissionRewards: () => ({
        missionInfo: [], itemList: {}, characterList: [], equipmentList: [], degreeIds: [],
    }),
})

const missionRoutes = require("../src/routes/api/mission").default
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
function setServerTime(isoTimestamp) {
    setServerTimeOffset(Date.parse(isoTimestamp) - Date.now())
}

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-progress-route-test-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000017
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

async function postProgress(fastify, missionPattern, progressValue) {
    return fastify.inject({
        method: "POST",
        url: "/update_mission_progress",
        payload: {
            viewer_id: viewerId,
            api_count: 1,
            mission_param_list: [{
                mission_pattern: missionPattern,
                progress_value: progressValue,
            }],
        },
    })
}

async function main() {
    setServerTime("2024-08-14T12:00:00.000Z")
    const fastify = Fastify()
    await fastify.register(missionRoutes)
    await fastify.ready()

    try {
        await postProgress(fastify, "unknown_pattern", 1)
        await postProgress(fastify, "twitter_check", -1)
        await postProgress(fastify, "collect_item_event_001_01", 1)
        await postProgress(fastify, "twitter_check", 1)
        assert.deepEqual(
            getPlayerCategoryMissionsSync(playerId, 1),
            {},
            "未知、非法、非白名单和未开放任务不得写库",
        )

        setServerTime("2099-12-30T03:00:00.000Z")
        await postProgress(fastify, "twitter_check", 1)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[107].progress, 1)

        await postProgress(fastify, "twitter_check", Number.NaN)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[107].progress, 1)
    } finally {
        await fastify.close()
        cleanupDatabase()
        process.removeListener("exit", cleanupDatabase)
    }
}

main().then(
    () => console.log("mission progress route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
