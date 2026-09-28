"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-owner-db-"))
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

function missionRow({ eventId, pattern, missionIds = "" }) {
    const row = []
    row[0] = String(eventId)
    row[1] = "1"
    row[3] = `owner_${eventId}_${pattern}`
    row[29] = String(pattern)
    row[34] = "(None)"
    row[35] = ""
    row[36] = ""
    row[37] = ""
    row[55] = missionIds
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

function questMissionRow({ eventId, pattern, questKind, questA = "", questB = "", questC = "" }) {
    const row = missionRow({ eventId, pattern })
    row[34] = String(questKind)
    row[35] = String(questA)
    row[36] = String(questB)
    row[37] = String(questC)
    return row
}

function eventRow() {
    const row = []
    row[0] = "owner_event"
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
        90001: [questMissionRow({ eventId: 901, pattern: 57, questKind: 0, questA: 1, questB: 8, questC: 4 })],
        90002: [questMissionRow({ eventId: 901, pattern: 57, questKind: 9, questA: 500005, questC: 1 })],
        90006: [missionRow({ eventId: 901, pattern: 13, missionIds: "90001,90002" })],
    },
    "mission_active_event.json": {
        901: [eventRow()],
    },
    "mission_active_reward.json": {
        90001: { 1: [rewardRow()] },
        90002: { 1: [rewardRow()] },
        90006: { 1: [rewardRow(2)] },
    },
}

const {
    installFrozenTestContentSnapshot,
} = require("./helpers/content-snapshot-fixture.cjs")
const installedContentSnapshot = installFrozenTestContentSnapshot({
    targetVersion: "active-owner-test",
    tables,
})
restoreSnapshot = installedContentSnapshot.restore

const {
    publishActiveMissionOwnerStateWithinTransaction,
} = require("../src/lib/mission/active-publication-owner")
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerActiveMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    insertPlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
const serverNow = Date.parse("2024-08-14T12:00:00.000Z")
setServerTimeOffset(serverNow - Date.now())

initializeDatabase()
db = getDb()

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `active-owner-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function addFinishedQuest(playerId, questId) {
    insertPlayerQuestProgressSync(playerId, 1, {
        questId,
        finished: true,
        unlocked: true,
    })
}

function deltaIds(result) {
    return result.activeMissionList.map(delta => delta.mission_id)
}

test("owner publication rejects calls outside a business transaction", () => {
    const playerId = createPlayer()
    assert.equal(getDb().inTransaction, false)
    assert.throws(
        () => publishActiveMissionOwnerStateWithinTransaction({
            playerId,
            now: serverNow,
            source: "owner-test",
        }),
        /transaction/i,
    )
})

test("owner publication reads after-write facts and converges dependencies in one call", () => {
    const playerId = createPlayer()
    const result = db.transaction(() => {
        addFinishedQuest(playerId, 1008004)
        addFinishedQuest(playerId, 500005001)
        return publishActiveMissionOwnerStateWithinTransaction({
            playerId,
            now: serverNow,
            source: "owner-test",
        })
    })()
    assert.deepEqual(deltaIds(result).sort((left, right) => left - right), [90001, 90002, 90006])
    const byId = Object.fromEntries(result.activeMissionList.map(delta => [delta.mission_id, delta]))
    assert.equal(byId[90001].progress_value, 1)
    assert.equal(byId[90002].progress_value, 1)
    assert.equal(
        byId[90006].progress_value,
        2,
        "依赖任务固定点必须在同一次 owner 调用内收敛",
    )
    assert.ok(result.activeMissions)
    assert.equal(result.activeMissions[90006]?.progress ?? 0, 2)
})

test("second owner publication is idempotent with empty deltas", () => {
    const playerId = createPlayer()
    const first = db.transaction(() => {
        addFinishedQuest(playerId, 1008004)
        return publishActiveMissionOwnerStateWithinTransaction({
            playerId,
            now: serverNow,
            source: "owner-test",
        })
    })()
    assert.deepEqual(deltaIds(first), [90001, 90006])
    assert.equal(
        first.activeMissionList.find(delta => delta.mission_id === 90006)?.progress_value,
        1,
        "单个依赖完成时汇总任务进度为 1",
    )
    const second = db.transaction(() => publishActiveMissionOwnerStateWithinTransaction({
        playerId,
        now: serverNow,
        source: "owner-test",
    }))()
    assert.deepEqual(
        second.activeMissionList,
        [],
        "无新事实时 owner 必须返回空增量",
    )
    assert.equal(
        getPlayerActiveMissionsSync(playerId)[90001]?.progress ?? 0,
        1,
        "幂等调用不得回退进度",
    )
})

test("fixed-point write failure rolls the business write back with it", () => {
    const playerId = createPlayer()
    db.exec(`
        CREATE TRIGGER reject_owner_progress_update
        BEFORE UPDATE ON players_active_missions
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced owner fixed-point failure');
        END;
        CREATE TRIGGER reject_owner_progress_insert
        BEFORE INSERT ON players_active_missions
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced owner fixed-point failure');
        END;
    `)
    assert.throws(
        () => db.transaction(() => {
            addFinishedQuest(playerId, 1008004)
            publishActiveMissionOwnerStateWithinTransaction({
                playerId,
                now: serverNow,
                source: "owner-test",
            })
        })(),
        /forced owner fixed-point failure/,
    )
    db.exec("DROP TRIGGER reject_owner_progress_update")
    db.exec("DROP TRIGGER reject_owner_progress_insert")
    assert.deepEqual(
        db.prepare(`
            SELECT COUNT(*) AS count FROM players_quest_progress
            WHERE player_id = ? AND quest_id = 1008004
        `).get(playerId),
        { count: 0 },
        "固定点写失败必须连带回滚业务写入",
    )
    assert.equal(getPlayerActiveMissionsSync(playerId)[90001]?.progress ?? 0, 0)
})

test.after(() => {
    cleanup()
    process.removeListener("exit", cleanup)
})
