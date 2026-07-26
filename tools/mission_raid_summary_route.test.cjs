require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-raid-summary-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreTime = () => {}
let restoreSnapshot = () => {}
function cleanup() {
    if (db?.open) db.close()
    restoreTime()
    restoreSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "mission-raid-summary-test" },
    repository: {
        info: () => ({ source: "bundled", assetVersion: "test", generatorVersion: 1, releaseDigest: null }),
        table: tableName => require(path.join(__dirname, "../assets", tableName)),
    },
}
restoreSnapshot = () => { productionContentSnapshotProvider.snapshot = previousSnapshot }

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { activeQuests } = require("../src/lib/quest/active-quest-service")
const raidEventRoutes = require("../src/routes/api/raidEvent").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
function setServerTime(isoTimestamp) {
    setServerTimeOffset(Date.parse(isoTimestamp) - Date.now())
}

initializeDatabase()
db = getDb()
function createPlayer(label, viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-raid-summary-${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    return playerId
}
const playerId = createPlayer("main", 800000421)
const rollbackPlayerId = createPlayer("rollback", 800000422)

async function summary(fastify, viewerId, eventId, apiCount) {
    return fastify.inject({
        method: "POST",
        url: "/raid/summary",
        payload: { viewer_id: viewerId, event_id: eventId, api_count: apiCount },
    })
}

async function finishRaidBattle(fastify, viewerId) {
    activeQuests[playerId] = {
        questId: 4001,
        category: 23,
        eventId: 4,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "raid-finish-without-summary",
        continueCount: 0,
    }
    return fastify.inject({
        method: "POST",
        url: "/battle/finish",
        payload: {
            viewer_id: viewerId,
            quest_id: 4001,
            category: 23,
            score: 0,
            elapsed_time_ms: 1000,
            add_mana: 0,
            is_accomplished: true,
            is_restored: false,
            continue_count: 0,
            api_count: 1,
            statistics: {
                clear_phase: 1,
                max_combo_count: 0,
                zones: [],
                party: {
                    characters: [null, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
        },
    })
}

async function main() {
    const fastify = Fastify({ logger: false })
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(raidEventRoutes, { prefix: "/raid" })
    await fastify.register(singleBattleRoutes, { prefix: "/battle" })
    await fastify.ready()
    try {
        setServerTime("2024-05-23T04:00:00.000Z")
        const finish = await finishRaidBattle(fastify, 800000421)
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053], undefined, "真实 Raid finish 未进 summary 不得触发")

        const wrongEvent = await summary(fastify, 800000421, 5, 1)
        assert.equal(wrongEvent.statusCode, 200, wrongEvent.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053], undefined)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400071], undefined)

        const first = await summary(fastify, 800000421, 4, 2)
        assert.equal(first.statusCode, 200, first.body)
        const firstData = unpack(first.rawPayload).data
        assert.equal("mission_info" in firstData, false, "Raid summary 响应协议不得增加 mission 字段")
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053].progress, 1)

        const repeated = await summary(fastify, 800000421, 4, 3)
        assert.equal(repeated.statusCode, 200, repeated.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400053].progress, 1)

        setServerTime("2025-05-15T04:00:00.000Z")
        const eventSix = await summary(fastify, 800000421, 6, 4)
        assert.equal(eventSix.statusCode, 200, eventSix.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400089].progress, 1)

        setServerTime("2025-06-26T04:00:00.000Z")
        const eventSeven = await summary(fastify, 800000421, 7, 5)
        assert.equal(eventSeven.statusCode, 200, eventSeven.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[400093].progress, 1)

        setServerTime("2024-12-05T04:00:00.000Z")
        const warnings = []
        const originalWarn = console.warn
        console.warn = message => warnings.push(String(message))
        db.exec(`
            CREATE TRIGGER fail_raid_summary_mission_fact
            AFTER INSERT ON players_category_missions
            WHEN NEW.player_id = ${rollbackPlayerId} AND NEW.category = 3 AND NEW.id = 400071
            BEGIN
                SELECT RAISE(FAIL, 'forced raid summary mission failure');
            END
        `)
        try {
            const failedFact = await summary(fastify, 800000422, 5, 6)
            assert.equal(failedFact.statusCode, 200, failedFact.body)
            const failedFactData = unpack(failedFact.rawPayload).data
            assert.equal("mission_info" in failedFactData, false)
            assert.equal(getPlayerCategoryMissionsSync(rollbackPlayerId, 3)[400071], undefined)
            assert.equal(
                db.prepare("SELECT COUNT(*) AS count FROM players_category_missions WHERE player_id = ? AND category = 3 AND id = 400071")
                    .get(rollbackPlayerId).count,
                0,
                "任务事实保存点失败不得留下半写",
            )
            assert.equal(warnings.some(message => message.includes("raid summary fact") && message.includes("400071")), true)
        } finally {
            console.warn = originalWarn
            db.exec("DROP TRIGGER fail_raid_summary_mission_fact")
        }
    } finally {
        delete activeQuests[playerId]
        await fastify.close()
    }
}

main().then(
    () => console.log("mission raid summary route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
).finally(cleanup)
