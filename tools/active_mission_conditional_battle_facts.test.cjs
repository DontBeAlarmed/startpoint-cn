require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-condition-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getActiveMissionConditionalBattleFactsSync,
    incrementActiveMissionConditionalBattleFactSync,
} = require("../src/data/domains/active_mission_battle_condition_facts")
const {
    collectActiveMissionConditionalBattleFacts,
} = require("../src/lib/mission/active-conditional-battle-facts")
const {
    computeActiveMissionFactProgress,
} = require("../src/lib/mission/active-reconciliation")

function definition(missionId, pattern, battleKind = 2) {
    const row = []
    row[29] = String(pattern)
    row[32] = String(battleKind)
    row[34] = "(None)"
    row[43] = "121033"
    return { missionId, row }
}

const definitions = [
    definition(20003, 72),
    definition(20005, 73),
    definition(20007, 71),
]
const context = {
    questAccomplished: true,
    isMulti: true,
    questCategory: 2,
    questId: 1006003,
    partyCharacterIds: [121033, 999999],
}

assert.deepEqual(collectActiveMissionConditionalBattleFacts(definitions, context, {
    "121033": { level: 80, secondBoardAbilitiesComplete: true },
}), [
    { pattern: 71, characterId: 121033 },
    { pattern: 72, characterId: 121033 },
])
assert.deepEqual(collectActiveMissionConditionalBattleFacts(definitions, context, {
    "121033": { level: 100, secondBoardAbilitiesComplete: true },
}), [
    { pattern: 71, characterId: 121033 },
    { pattern: 72, characterId: 121033 },
    { pattern: 73, characterId: 121033 },
])
assert.deepEqual(collectActiveMissionConditionalBattleFacts(definitions, {
    ...context,
    isMulti: false,
}, { "121033": { level: 100, secondBoardAbilitiesComplete: true } }), [])
assert.deepEqual(collectActiveMissionConditionalBattleFacts(definitions, {
    ...context,
    partyCharacterIds: [999999],
}, { "121033": { level: 100, secondBoardAbilitiesComplete: true } }), [])

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `active-mission-condition-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
incrementActiveMissionConditionalBattleFactSync(playerId, 71, 121033)
incrementActiveMissionConditionalBattleFactSync(playerId, 71, 121033)
incrementActiveMissionConditionalBattleFactSync(playerId, 72, 121033)
assert.deepEqual(getActiveMissionConditionalBattleFactsSync(playerId), {
    "71:121033": 2,
    "72:121033": 1,
})
assert.throws(() => db.transaction(() => {
    incrementActiveMissionConditionalBattleFactSync(playerId, 73, 121033)
    throw new Error("rollback condition fact")
})(), /rollback condition fact/)
assert.equal(getActiveMissionConditionalBattleFactsSync(playerId)["73:121033"], undefined)

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {},
    finishedQuestIds: new Set(),
    questProgress: [],
    chapterQuestIds: {},
    practiceQuestChallengeCount: 0,
    leaderClearCounts: {},
    conditionalBattleFacts: getActiveMissionConditionalBattleFactsSync(playerId),
    characterStoryQuestIds: {},
    characters: {},
    equipment: [],
    manaNodes: {},
    manaBoardNodes: {},
    manaNodeSlots: {},
    partyAbilitySoulCount: 0,
    treasureShopPurchaseCount: 0,
    bossCoinShopPurchaseCount: 0,
    bossCoinEquipmentShopPurchaseCount: 0,
    totalUsedManaCount: 0,
    totalGachaCharacterCount: 0,
    totalEquipmentEquipCount: 0,
    totalUnisonSetCount: 0,
    totalPartyCharacterSetCount: 0,
    totalInjectedExpCount: 0,
    totalGachaCampaignCount: 0,
}
for (const pattern of [71, 72, 73]) {
    const row = definition(1, pattern).row
    assert.equal(computeActiveMissionFactProgress(pattern, row, state), pattern === 71 ? 2 : pattern === 72 ? 1 : 0)
}

console.log("active mission conditional battle fact tests passed")
cleanup()
process.removeListener("exit", cleanup)
