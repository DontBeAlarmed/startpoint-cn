require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pass-facts-db-"))
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
const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

function context(overrides = {}) {
    return {
        playerId,
        questCategory: 7,
        questId: 200015001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: {
            clear_phase: 1,
            party: { characters: [], unison_characters: [] },
            zones: [],
        },
        player,
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
        ...overrides,
    }
}

recordMissionBattleFacts(context({
    questAccomplished: false,
    isMulti: false,
    isMultiHost: undefined,
    statistics: {
        clear_phase: 1,
        party: { characters: [], unison_characters: [] },
        zones: [{ send_emotion_count: 10 }],
    },
}), evaluationTime)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 7)[11],
    undefined,
    "单人战斗不得推进仅在协力界面可发送的表情周常",
)

recordMissionBattleFacts(context({
    questAccomplished: false,
    statistics: {
        clear_phase: 1,
        party: { characters: [], unison_characters: [] },
        zones: [{ use_emotion_count: 10 }],
    },
}), evaluationTime)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 7)[11],
    undefined,
    "收到或执行表情的 use_emotion_count 不得冒充主动发送次数",
)

recordMissionBattleFacts(context({
    questAccomplished: false,
    statistics: {
        clear_phase: 1,
        party: { characters: [], unison_characters: [] },
        zones: [{ send_emotion_count: 4 }, { send_emotion_count: -1 }],
    },
}), evaluationTime)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 7)[11],
    undefined,
    "任一场景表情统计非法时整次事实必须 fail closed",
)

recordMissionBattleFacts(context({
    questAccomplished: false,
    statistics: {
        clear_phase: 1,
        party: { characters: [], unison_characters: [] },
        zones: [{ send_emotion_count: 4 }, { send_emotion_count: 6 }],
    },
}), evaluationTime)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 7)[11]?.progress,
    10,
    "表情周常应累计所有 zone 的主动发送次数且不要求通关",
)
assert.throws(() => db.transaction(() => {
    recordMissionBattleFacts(context({
        questAccomplished: false,
        statistics: {
            clear_phase: 1,
            party: { characters: [], unison_characters: [] },
            zones: [{ send_emotion_count: 2 }],
        },
    }), evaluationTime)
    throw new Error("rollback-pass-emotion")
})(), /rollback-pass-emotion/)
assert.equal(
    getPlayerCategoryMissionsSync(playerId, 7)[11]?.progress,
    10,
    "外层结算事务回滚时不得留下表情任务进度",
)

recordMissionBattleFacts(context(), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[15]?.progress, 1)

recordMissionBattleFacts(context({ questAccomplished: false }), evaluationTime)
recordMissionBattleFacts(context({ questCategory: 8 }), evaluationTime)
recordMissionBattleFacts(context({ questId: 200016001 }), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[15]?.progress, 1)

recordMissionBattleFacts(context({ questCategory: 2, questId: 1025001 }), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[16]?.progress, 1)

const raidPassTime = new Date("2024-06-03T12:00:00.000Z")
recordMissionBattleFacts(context({
    questCategory: 23,
    questId: 4001,
    isMulti: false,
    isMultiHost: undefined,
}), raidPassTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[2]?.progress, 1)
recordMissionBattleFacts(context({
    questCategory: 23,
    questId: 4001,
    isMulti: true,
}), raidPassTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[2]?.progress, 1)

const rushPassTime = new Date("2024-07-10T12:00:00.000Z")
recordMissionBattleFacts(context({
    questCategory: 24,
    questId: 700004001,
    isMulti: false,
    isMultiHost: undefined,
}), rushPassTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[9]?.progress, 1)
recordMissionBattleFacts(context({
    questCategory: 24,
    questId: 700005001,
    isMulti: false,
    isMultiHost: undefined,
}), rushPassTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[9]?.progress, 1)

console.log("mission pass battle fact tests passed")
cleanup()
process.removeListener("exit", cleanup)
