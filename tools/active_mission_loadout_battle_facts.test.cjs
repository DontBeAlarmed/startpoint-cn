require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-loadout-db-"))
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
    getActiveMissionBattleFactsSync,
    incrementActiveMissionBattleFactSync,
} = require("../src/data/domains/active_mission_battle_facts")
const {
    collectActiveMissionLoadoutBattleFacts,
} = require("../src/lib/mission/active-loadout-battle-facts")
const {
    computeActiveMissionFactProgress,
} = require("../src/lib/mission/active-reconciliation")

function definition(missionId, characterElement, equipmentElement = "(None)", battleKind = 3) {
    const row = []
    row[29] = "89"
    row[32] = String(battleKind)
    row[34] = "(None)"
    row[69] = String(characterElement)
    row[70] = equipmentElement
    return { missionId, row }
}

const definitions = [
    definition(20011, 1),
    definition(20012, 1, "1"),
    definition(20013, 3),
    definition(20014, 3, "3"),
]

assert.deepEqual(collectActiveMissionLoadoutBattleFacts(definitions, {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2],
    equipmentElements: [0, 2],
}, {
    "1": { element: 0 },
    "2": { element: 2 },
}), [
    { missionId: 20011 },
    { missionId: 20012 },
    { missionId: 20013 },
    { missionId: 20014 },
])

assert.deepEqual(collectActiveMissionLoadoutBattleFacts(definitions, {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2],
}, {
    "1": { element: 0 },
    "2": { element: 2 },
}), [
    { missionId: 20011 },
    { missionId: 20013 },
])

assert.deepEqual(collectActiveMissionLoadoutBattleFacts(definitions, {
    questAccomplished: false,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2],
    equipmentElements: [0, 2],
}, {
    "1": { element: 0 },
    "2": { element: 2 },
}), [])

assert.deepEqual(collectActiveMissionLoadoutBattleFacts([
    definition(20020, 1, "(None)", 1),
    definition(20021, 1, "(None)", 2),
], {
    questAccomplished: true,
    isMulti: true,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1],
}, {
    "1": { element: 0 },
}), [{ missionId: 20021 }])

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "active-mission-loadout-" + randomUUID(),
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
incrementActiveMissionBattleFactSync(playerId, 20011)
incrementActiveMissionBattleFactSync(playerId, 20011)
incrementActiveMissionBattleFactSync(playerId, 20012)
assert.deepEqual(getActiveMissionBattleFactsSync(playerId), {
    "20011": 2,
    "20012": 1,
})

assert.throws(() => db.transaction(() => {
    incrementActiveMissionBattleFactSync(playerId, 20013)
    throw new Error("rollback loadout fact")
})(), /rollback loadout fact/)
assert.equal(getActiveMissionBattleFactsSync(playerId)["20013"], undefined)

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {},
    finishedQuestIds: new Set(),
    questProgress: [],
    chapterQuestIds: {},
    practiceQuestChallengeCount: 0,
    leaderClearCounts: {},
    conditionalBattleFacts: {},
    loadoutBattleFacts: getActiveMissionBattleFactsSync(playerId),
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
assert.equal(computeActiveMissionFactProgress(89, definitions[0].row, state, 20011), 2)
assert.equal(computeActiveMissionFactProgress(89, definitions[1].row, state, 20012), 1)
assert.equal(computeActiveMissionFactProgress(89, definitions[2].row, state, 20013), 0)

console.log("active mission loadout battle fact tests passed")
cleanup()
process.removeListener("exit", cleanup)
