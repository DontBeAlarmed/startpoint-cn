require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-facts-db-"))
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
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    BATTLE_SETTLEMENT_CATEGORIES,
    recordMissionBattleFacts,
} = require("../src/lib/mission/battle-facts")
const {
    getSafeEventBattleRuleCoverage,
    recordEventMissionBattleFacts,
} = require("../src/lib/mission/event-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-event-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)

function finishContext(overrides = {}) {
    return {
        playerId,
        questCategory: 2,
        questId: 1001001,
        questAccomplished: true,
        clearTime: 10_000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: { clear_phase: 1, party: { characters: [], unison_characters: [] } },
        player,
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
        ...overrides,
    }
}

assert.deepEqual(getSafeEventBattleRuleCoverage(), {
    totalEventMissions: 2512,
    safeMultiClearRules: 939,
})
assert.deepEqual(BATTLE_SETTLEMENT_CATEGORIES, [1, 2, 3, 6, 7, 8, 10])

const activeTime = new Date("2020-01-01T03:00:00.000Z")
const firstMatches = recordEventMissionBattleFacts(finishContext(), activeTime)
assert.equal(firstMatches.includes(1400), true)
assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1400].progress, 1)

recordEventMissionBattleFacts(finishContext(), activeTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1400].progress, 2)

assert.deepEqual(recordEventMissionBattleFacts(
    finishContext({ questAccomplished: false }),
    activeTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    finishContext({ isMulti: false }),
    activeTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    finishContext({ questId: 999999999 }),
    activeTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    finishContext(),
    new Date("2024-08-14T12:00:00.000Z"),
), [])
assert.equal(getPlayerCategoryMissionsSync(playerId, 3)[1400].progress, 2)

recordMissionBattleFacts(finishContext(), activeTime)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 3)[1400].progress,
    3,
    "通用 finish 事实入口必须同时记录安全活动任务事实",
)

const oneClearEventTime = new Date("2020-03-01T04:00:00.000Z")
recordMissionBattleFacts(finishContext(), oneClearEventTime)
const settlement = settleMissionCategories(playerId, [3], oneClearEventTime)
assert.equal(settlement.missionInfo.some(info => info.mission_id === 1407), true)
assert.equal(settlement.itemList["40020"], 50)

console.log("mission event battle facts tests passed")
cleanup()
process.removeListener("exit", cleanup)
