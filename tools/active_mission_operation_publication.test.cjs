"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-operation-db-"))
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

function missionRow({ eventId, pattern }) {
    const row = []
    row[0] = String(eventId)
    row[1] = "1"
    row[3] = `operation_${eventId}_${pattern}`
    row[29] = String(pattern)
    row[34] = "(None)"
    row[35] = ""
    row[36] = ""
    row[37] = ""
    row[55] = ""
    row[56] = "(None)"
    row[57] = ""
    row[58] = "(None)"
    row[59] = ""
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    row[62] = "2020-01-01 00:00:00"
    row[63] = "(None)"
    return row
}

function eventRow() {
    const row = []
    row[0] = "operation_event"
    row[2] = "0"
    row[3] = "1"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "(None)"
    row[22] = "(None)"
    return row
}

function rewardRow(targetProgress = 1) {
    const row = []
    row[3] = String(targetProgress)
    row[4] = "(None)"
    row[7] = "0"
    row[8] = "5"
    return row
}

const {
    QUEST_TABLE_NAMES,
    getBundledStandardMissionTables,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const bundledQuestTables = Object.fromEntries(QUEST_TABLE_NAMES.map(tableName => [
    tableName,
    require(`../assets/${tableName}`),
]))

const tables = {
    "cdndata/player_rank_full.json": require("../assets/cdndata/player_rank_full.json"),
    ...getBundledStandardMissionTables(),
    ...bundledQuestTables,
    "mission_event_battle_rules.json": require("../assets/mission_event_battle_rules.json"),
    "mission_event_quest_map.json": require("../assets/mission_event_quest_map.json"),
    "daily_challenge_point_lookup.json": require("../assets/daily_challenge_point_lookup.json"),
    "event_challenge_point_map.json": require("../assets/event_challenge_point_map.json"),
    "hard_multi_event.json": require("../assets/hard_multi_event.json"),
    "hard_multi_event_quest.json": require("../assets/hard_multi_event_quest.json"),
    "periodic_reward_point.json": require("../assets/periodic_reward_point.json"),
    "periodic_reward.json": require("../assets/periodic_reward.json"),
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
    "character_quest_lookup.json": require("../assets/character_quest_lookup.json"),
    "mission_char_awake_reward.json": require("../assets/mission_char_awake_reward.json"),
    "character.json": require("../assets/character.json"),
    "config.json": require("../assets/config.json"),
    "item_inventory_policy.json": require("../assets/item_inventory_policy.json"),
    "item_max_count.json": require("../assets/item_max_count.json"),
    "login_bonus.json": require("../assets/login_bonus.json"),
    "mana_node.json": require("../assets/mana_node.json"),
    "mana_board.json": require("../assets/mana_board.json"),
    "mana_node_awake.json": require("../assets/mana_node_awake.json"),
    "character_level.json": require("../assets/character_level.json"),
    "level_required_mana_node.json": require("../assets/level_required_mana_node.json"),
    "mana_board2_open_condition.json": {},
    "mission_active.json": {
        91063: [missionRow({ eventId: 951, pattern: 63 })],
        91046: [missionRow({ eventId: 951, pattern: 46 })],
    },
    "mission_active_event.json": {
        951: [eventRow()],
    },
    "mission_active_reward.json": {
        91063: { 1: [rewardRow()] },
        91046: { 1: [rewardRow()] },
    },
}

const {
    installFrozenTestContentSnapshot,
} = require("./helpers/content-snapshot-fixture.cjs")
restoreSnapshot = installFrozenTestContentSnapshot({
    targetVersion: "active-operation-test",
    tables,
}).restore

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerActiveMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getCharacterGrowthContent } = require("../src/lib/character-growth-content")
const { executeInjectCharacterExp } = require("../src/lib/character-growth/commands/inject-exp")
const {
    executeLearnManaNodes,
} = require("../src/lib/character-growth/commands/learn-mana-nodes")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
setServerTimeOffset(evaluationTime.getTime() - Date.now())

initializeDatabase()
db = getDb()

function createPlayerWithCharacter() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `active-operation-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    if (getPlayerCharacterSync(playerId, 1) === null) {
        insertDefaultPlayerCharacterSync(playerId, 1)
    }
    return playerId
}

test("inject-exp publishes the Active Mission delta inside the growth transaction", () => {
    const playerId = createPlayerWithCharacter()
    updatePlayerSync({ id: playerId, expPool: 100 })

    const result = executeInjectCharacterExp({
        playerId,
        characterId: 1,
        addExp: 50,
        evaluationTime,
    })
    assert.deepEqual(result.activeMissionList, [{
        mission_id: 91063,
        progress_value: 1,
        stages: [{ stage: 1, received: false }],
    }])
    assert.equal(getPlayerActiveMissionsSync(playerId)[91063]?.progress ?? 0, 1)

    assert.throws(
        () => executeInjectCharacterExp({
            playerId,
            characterId: 1,
            addExp: 999999,
            evaluationTime,
        }),
        "exp 池不足必须先于 owner 失败",
    )
    assert.equal(getPlayerActiveMissionsSync(playerId)[91063]?.progress ?? 0, 1)
})

test("inject-exp fixed-point failure rolls the growth writes back", () => {
    const playerId = createPlayerWithCharacter()
    updatePlayerSync({ id: playerId, expPool: 100 })
    db.exec(`
        CREATE TRIGGER reject_operation_progress_write
        BEFORE INSERT ON players_active_missions
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced operation fixed-point failure'); END;
    `)
    assert.throws(
        () => executeInjectCharacterExp({
            playerId,
            characterId: 1,
            addExp: 50,
            evaluationTime,
        }),
        /forced operation fixed-point failure/,
    )
    db.exec("DROP TRIGGER reject_operation_progress_write")
    assert.equal(db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId).exp_pool, 100)
    assert.equal(
        db.prepare(`
            SELECT total_injected_exp_count AS count
            FROM players_active_mission_counters WHERE player_id = ?
        `).get(playerId)?.count ?? 0,
        0,
        "固定点写失败必须连带回滚操作计数器",
    )
    assert.equal(getPlayerActiveMissionsSync(playerId)[91063]?.progress ?? 0, 0)
})

test("learn-mana-nodes publishes the used-mana Active Mission delta", () => {
    const playerId = createPlayerWithCharacter()
    const nodes = getCharacterGrowthContent().getManaBoardNodes(1, 1)
    const nodeId = Number(Object.keys(nodes)[0])
    const node = nodes[String(nodeId)]
    updatePlayerSync({ id: playerId, freeMana: node.manaCost, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(node.items ?? {})) {
        setInventoryFixtureItemExactSync(playerId, itemId, amount)
    }

    const result = executeLearnManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [nodeId],
        evaluationTime,
    })
    assert.deepEqual(
        result.activeMissionList.map(delta => [delta.mission_id, delta.progress_value]),
        [[91046, node.manaCost]],
        "玛纳消费事实必须在同一命令事务内发布 Active Mission 进度",
    )
    assert.equal(
        getPlayerActiveMissionsSync(playerId)[91046]?.progress ?? 0,
        node.manaCost,
    )
})

test.after(() => {
    cleanup()
    process.removeListener("exit", cleanup)
})
