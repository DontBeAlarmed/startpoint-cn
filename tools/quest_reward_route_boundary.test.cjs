require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")

const multiBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/http/battle.ts"),
    "utf8",
)
const singleBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
assert.match(multiBattleSource, /settleActivityPeriodicRewardsSync/)
assert.match(multiBattleSource, /user_periodic_reward_point_list/)
assert.doesNotMatch(singleBattleSource, /settleActivityPeriodicRewardsSync/)
assert.match(singleBattleSource, /"drop_periodic_reward_ids": \[\]/)

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quest-reward-boundary-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const hardMultiQuests = structuredClone(require("../assets/hard_multi_event_quest.json"))
hardMultiQuests["100002001"].clearRewardId = 999999999
restoreContentSnapshot = installBundledGameplaySnapshot({
    tableOverrides: { "hard_multi_event_quest.json": hardMultiQuests },
})

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, getPlayerSync } = require("../src/data/domains/player")
const { getPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { activeQuests } = require("../src/lib/quest/active-quest-service")
const { QuestCategory } = require("../src/lib/types")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { registerBattleRoutes } = require("../src/multi/http/battle")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `quest-reward-boundary-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000231
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

const questId = 100002001
const category = QuestCategory.HARD_MULTI_EVENT

function activeQuest(isMulti) {
    return {
        questId,
        category,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti,
        playId: isMulti ? "multi-config-error" : "single-config-error",
        continueCount: 0,
    }
}

function singleFinishBody() {
    return {
        viewer_id: viewerId,
        play_id: "single-config-error",
        quest_id: questId,
        category,
        score: 0,
        elapsed_time_ms: 1000,
        add_mana: 0,
        is_accomplished: true,
        is_restored: false,
        continue_count: 0,
        statistics: {
            clear_phase: 0,
            zones: [],
            party: {
                characters: [{ id: 1 }],
                unison_characters: [null],
                equipments: [],
                ability_soul_ids: [],
            },
        },
    }
}

function assertConfigurationError(response, field, rewardId) {
    assert.equal(response.statusCode, 500, response.body)
    assert.deepEqual(JSON.parse(response.body), {
        error: "Internal Server Error",
        message: "Quest reward configuration is invalid.",
        category,
        quest_id: questId,
        reward_id: rewardId,
        field,
    })
}

function stateSnapshot() {
    return {
        player: getPlayerSync(playerId),
        questProgress: getPlayerQuestProgressSync(playerId),
        persistedActiveQuestCount: db.prepare(
            "SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?",
        ).get(playerId).count,
    }
}

async function main() {
    const app = Fastify({ logger: false })
    await app.register(singleBattleRoutes, { prefix: "/single" })
    const multiContext = createEmbeddedMultiHttpContext()
    await app.register(
        async instance => registerBattleRoutes(instance, multiContext),
        { prefix: "/multi" },
    )
    await app.ready()

    const before = stateSnapshot()

    try {
        const singleStart = await app.inject({
            method: "POST",
            url: "/single/start",
            payload: {
                viewer_id: viewerId,
                quest_id: questId,
                category,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "single-start-config-error",
            },
        })
        assertConfigurationError(singleStart, "clearRewardId", 999999999)
        assert.deepEqual(stateSnapshot(), before, "单人 start 配置错误不得写入")

        const multiStart = await app.inject({
            method: "POST",
            url: "/multi/start",
            payload: {
                viewer_id: viewerId,
                quest_id: questId,
                category,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                room_number: "missing-room",
                mate_player_ids: [],
                play_id: "multi-start-config-error",
            },
        })
        assertConfigurationError(multiStart, "clearRewardId", 999999999)
        assert.deepEqual(stateSnapshot(), before, "联机 start 配置错误不得写入")

        activeQuests[playerId] = activeQuest(false)
        const singleFinish = await app.inject({
            method: "POST",
            url: "/single/finish",
            payload: singleFinishBody(),
        })
        assertConfigurationError(singleFinish, "clearRewardId", 999999999)
        assert.deepEqual(stateSnapshot(), before, "单人 finish 配置错误不得写入")
        assert.deepEqual(activeQuests[playerId], activeQuest(false), "单人 active quest 必须保留")

        activeQuests[playerId] = activeQuest(true)
        const multiFinish = await app.inject({
            method: "POST",
            url: "/multi/finish",
            payload: { viewer_id: viewerId },
        })
        assertConfigurationError(multiFinish, "clearRewardId", 999999999)
        assert.deepEqual(stateSnapshot(), before, "联机 finish 配置错误不得写入")
        assert.deepEqual(activeQuests[playerId], activeQuest(true), "联机 active quest 必须保留")
    } finally {
        delete activeQuests[playerId]
        await app.close()
        cleanup()
    }
}

main().then(() => {
    console.log("quest reward route boundary tests passed")
}).catch(error => {
    console.error(error)
    process.exitCode = 1
})
