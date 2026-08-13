require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-specific-battle-db-"))
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
    collectActiveMissionSpecificBattleFacts,
    recordActiveMissionSpecificBattleFactsSync,
} = require("../src/lib/mission/active-mission-specific-battle-facts")
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

function skillStartDefinition(missionId, battleKind = 3) {
    const row = []
    row[29] = "91"
    row[32] = String(battleKind)
    row[34] = "(None)"
    return { missionId, row }
}

function skillEffectDefinition(missionId, effects, ignored = "(None)") {
    const row = []
    row[29] = "90"
    row[32] = "3"
    row[34] = "(None)"
    row[69] = effects
    row[70] = ignored
    return { missionId, row }
}

function mainQuestSkillStartDefinition(missionId, questId = 1001001) {
    const definition = skillStartDefinition(missionId)
    definition.row[34] = "0"
    definition.row[35] = String(Math.floor(questId / 1_000_000))
    definition.row[36] = String(Math.floor(questId % 1_000_000 / 1_000))
    definition.row[37] = String(questId % 1_000)
    return definition
}

const definitions = [
    definition(20011, 1),
    definition(20012, 1, "1"),
    definition(20013, 3),
    definition(20014, 3, "3"),
]

assert.deepEqual(collectActiveMissionSpecificBattleFacts(definitions, {
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

assert.deepEqual(collectActiveMissionSpecificBattleFacts(definitions, {
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

// Element missions without a slot selector also accept a matching Sub/Unison character.
assert.deepEqual(collectActiveMissionSpecificBattleFacts(definitions, {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [4],
    unisonCharacterIds: [2],
    equipmentElements: [2],
}, {
    "2": { element: 2 },
    "4": { element: 4 },
}), [
    { missionId: 20013 },
    { missionId: 20014 },
])

assert.deepEqual(collectActiveMissionSpecificBattleFacts(definitions, {
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

assert.deepEqual(collectActiveMissionSpecificBattleFacts([
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

const skillStartDefinitions = [skillStartDefinition(20017)]
assert.deepEqual(collectActiveMissionSpecificBattleFacts(skillStartDefinitions, {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2, 3],
    zones: [
        { skill_point_over_on_start: 2 },
        { skill_point_over_on_start: 1 },
    ],
}, {}), [{ missionId: 20017 }])

for (const zones of [
    [{ skill_point_over_on_start: 2 }],
    [{ skill_point_over_on_start: 2 }, {}],
    [{ skill_point_over_on_start: -1 }, { skill_point_over_on_start: 4 }],
    [{ skill_point_over_on_start: 1.5 }, { skill_point_over_on_start: 1.5 }],
    [{ skill_point_over_on_start: 3 }, { skill_point_over_on_start: 1 }],
]) {
    assert.deepEqual(collectActiveMissionSpecificBattleFacts(skillStartDefinitions, {
        questAccomplished: true,
        isMulti: false,
        questCategory: 1,
        questId: 1001001,
        partyCharacterIds: [1, 2, 3],
        zones,
    }, {}), [])
}

assert.deepEqual(collectActiveMissionSpecificBattleFacts([
    skillStartDefinition(20017, 1),
    skillStartDefinition(20018, 2),
], {
    questAccomplished: true,
    isMulti: true,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2, 3],
    zones: [{ skill_point_over_on_start: 3 }],
}, {}), [{ missionId: 20018 }])

assert.deepEqual(collectActiveMissionSpecificBattleFacts([
    mainQuestSkillStartDefinition(20017),
], {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2, 3],
    zones: [{ skill_point_over_on_start: 3 }],
}, {}), [{ missionId: 20017 }])

assert.deepEqual(collectActiveMissionSpecificBattleFacts([
    mainQuestSkillStartDefinition(20017),
], {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001002,
    partyCharacterIds: [1, 2, 3],
    zones: [{ skill_point_over_on_start: 3 }],
}, {}), [])

const skillEffects = {
    "1": { stringId: "ordinary", unisonable: false, effects: ["Other"] },
    "2": { stringId: "valid_resistance_down", unisonable: true, effects: ["ACToleranceOfElement_Down"] },
    "3": { stringId: "compliment_oiran", unisonable: true, effects: ["CreateRatioHeal"] },
}
assert.deepEqual(collectActiveMissionSpecificBattleFacts([
    skillEffectDefinition(20015, "ACToleranceOfElement_Down"),
    skillEffectDefinition(20016, "CreateNormalHeal,CreateRatioHeal,ACRegeneration"),
], {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1],
    unisonCharacterIds: [2],
    skillEffects,
}, {}), [{ missionId: 20015 }])
assert.deepEqual(collectActiveMissionSpecificBattleFacts([
    skillEffectDefinition(20016, "CreateNormalHeal,CreateRatioHeal,ACRegeneration", "compliment_oiran"),
], {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [3],
    unisonCharacterIds: [],
    skillEffects,
}, {}), [])

const malformedRange = skillStartDefinition(20017)
malformedRange.row[34] = "999"
assert.deepEqual(collectActiveMissionSpecificBattleFacts([malformedRange], {
    questAccomplished: true,
    isMulti: false,
    questCategory: 1,
    questId: 1001001,
    partyCharacterIds: [1, 2, 3],
    zones: [{ skill_point_over_on_start: 3 }],
}, {}), [])

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "active-mission-specific-battle-" + randomUUID(),
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
recordActiveMissionSpecificBattleFactsSync({
    playerId,
    questCategory: 1,
    questId: 1001001,
    questAccomplished: true,
    clearTime: 1000,
    clearRank: 5,
    party: {
        characters: [{ id: 1 }, { id: 2 }, { id: 3 }],
        unison_characters: [null, null, null],
    },
    statistics: {
        clear_phase: 1,
        party: {
            characters: [{ id: 1 }, { id: 2 }, { id: 3 }],
            unison_characters: [null, null, null],
        },
        zones: [{ skill_point_over_on_start: 3 }],
    },
    player: {},
    questPreviouslyCompleted: false,
    questProgress: null,
})
assert.equal(getActiveMissionBattleFactsSync(playerId)["20017"], 1)

incrementActiveMissionBattleFactSync(playerId, 20011)
incrementActiveMissionBattleFactSync(playerId, 20011)
incrementActiveMissionBattleFactSync(playerId, 20012)
assert.deepEqual(getActiveMissionBattleFactsSync(playerId), {
    "20011": 2,
    "20012": 1,
    "20017": 1,
})

assert.throws(() => db.transaction(() => {
    incrementActiveMissionBattleFactSync(playerId, 20013)
    throw new Error("rollback specific battle fact")
})(), /rollback specific battle fact/)
assert.equal(getActiveMissionBattleFactsSync(playerId)["20013"], undefined)

const rollbackAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "active-mission-specific-battle-rollback-" + randomUUID(),
    status: "normal",
})
const rollbackPlayerId = insertDefaultPlayerSync(rollbackAccount.id).id
assert.throws(() => db.transaction(() => {
    recordActiveMissionSpecificBattleFactsSync({
        playerId: rollbackPlayerId,
        questCategory: 1,
        questId: 1001001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: {
            characters: [{ id: 1 }, { id: 2 }, { id: 3 }],
            unison_characters: [null, null, null],
        },
        statistics: {
            clear_phase: 1,
            party: {
                characters: [{ id: 1 }, { id: 2 }, { id: 3 }],
                unison_characters: [null, null, null],
            },
            zones: [{ skill_point_over_on_start: 3 }],
        },
        player: {},
        questPreviouslyCompleted: false,
        questProgress: null,
    })
    throw new Error("rollback actual recorder")
})(), /rollback actual recorder/)
assert.equal(getActiveMissionBattleFactsSync(rollbackPlayerId)["20017"], undefined)

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
assert.equal(computeActiveMissionFactProgress(91, skillStartDefinitions[0].row, state, 20017), 1)

console.log("active mission specific battle fact tests passed")
cleanup()
process.removeListener("exit", cleanup)
