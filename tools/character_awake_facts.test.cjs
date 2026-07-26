require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    AWAKE_GENERIC_CHARACTER_CLEAR_RULES,
    AWAKE_MISSION_RULE_FAMILIES,
    AWAKE_DIRECT_BATTLE_MISSION_IDS,
    getAwakeBattleProgressFacts,
    getMatchedAwakeDirectBattleMissionIds,
    getMatchedAwakeRaceMissionIds,
    getMatchedAwakeQuestPartyMissionIds,
    isBondTokenMissionComplete,
    mergePartyCoClearRows,
    normalizeCharacterPair,
} = require("../src/lib/mission/awake-battle-rules")
const { getComputer } = require("../src/lib/mission")

assert.deepEqual(normalizeCharacterPair(231001, 211001), [211001, 231001])
assert.deepEqual(
    mergePartyCoClearRows([
        { char_id_a: 211001, char_id_b: 231001, co_clear_count: 2 },
        { char_id_a: 231001, char_id_b: 211001, co_clear_count: 3 },
    ]),
    new Map([["211001_231001", 5]]),
)

assert.deepEqual(
    getMatchedAwakeRaceMissionIds(
        questPartyContext(1, 1, [231001, 1, 999]),
        "Devil+Dragon+Human",
    ),
    [],
)
assert.deepEqual(
    getMatchedAwakeRaceMissionIds(
        questPartyContext(1, 1, [1, 231001, 999]),
        "Devil+Dragon+Human",
    ),
    [],
)

const expectedFamilyCounts = {
    "all-complete": 36,
    "bond-token": 4,
    "exact-quest-atomic": 7,
    "exact-quest-history": 1,
    "generic-character-clear": 55,
    "leader-clear": 1,
    "leader-combo": 1,
    "leader-coop": 2,
    "leader-powerflip": 2,
    "mana-total": 1,
    "quest-range-character": 4,
    "race-selector-unresolved": 1,
    "same-party-quest": 3,
    "same-party-three": 1,
    "same-party-two": 4,
    "statistics-17-unresolved": 2,
    "story-read": 18,
    "total-story-read": 1,
}
assert.deepEqual(
    Object.fromEntries(AWAKE_MISSION_RULE_FAMILIES.map(family => [
        family.family,
        family.missionIds.length,
    ])),
    expectedFamilyCounts,
)
const partitionedMissionIds = AWAKE_MISSION_RULE_FAMILIES.flatMap(family => family.missionIds)
assert.equal(partitionedMissionIds.length, 144)
assert.equal(new Set(partitionedMissionIds).size, 144)
assert.deepEqual(
    [...partitionedMissionIds].sort((left, right) => left - right),
    Object.keys(require("../assets/mission_char_awake.json")).map(Number).sort((left, right) => left - right),
)

const expectedGenericMissionIds = [
    1110012, 1110031, 1110032, 1110033, 1210051, 1210052, 1210053,
    1310041, 1310042, 1310043, 1410011, 1410012, 1410013,
    1510071, 1510072, 1510073, 1610011, 1610012, 1610013,
    2110021, 2110022, 2110023, 2210011, 2210012, 2210013,
    2310061, 2310062, 2310063, 2410021, 2410022, 2410023,
    2510061, 2510062, 2510063, 2610031, 2610032, 2610033,
    3110021, 3110022, 3110023, 3210091, 3210092, 3210093,
    3310021, 3310022, 3310023, 3410051, 3410052, 3410053,
    3510011, 3510012, 3510013, 3610021, 3610022, 3610023,
]
assert.deepEqual(
    AWAKE_GENERIC_CHARACTER_CLEAR_RULES.map(rule => rule.missionId),
    expectedGenericMissionIds,
)

function questPartyContext(category, questId, ids, isMulti = false) {
    return {
        questCategory: category,
        questId,
        isMulti,
        party: {
            characters: ids.map(id => ({ id })),
            unison_characters: [],
        },
    }
}

assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(15, 5, [1, 331003])),
    [3310032],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(15, 6, [331003, 1])),
    [],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(2, 1010004, [10, 331003])),
    [3310033],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(2, 1010004, [331003])),
    [],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(2, 1010004, [10, 331003], true)),
    [],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(1, 9999, [151006, 263002])),
    [1510062],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(1, 9999, [263002, 151006])),
    [],
)
assert.deepEqual(
    getMatchedAwakeQuestPartyMissionIds(questPartyContext(1, 9999, [151006])),
    [],
)

assert.equal(isBondTokenMissionComplete([]), false)
assert.equal(isBondTokenMissionComplete([{ status: 2 }, { status: 3 }]), true)
assert.equal(isBondTokenMissionComplete([{ status: 2 }, { status: 1 }]), false)

function directBattleContext(category, questId, ids, options = {}) {
    return {
        questCategory: category,
        questId,
        isMulti: options.isMulti ?? false,
        party: {
            characters: ids.map(id => ({ id })),
            unison_characters: options.unisonIds?.map(id => ({ id })) ?? [],
        },
        statistics: options.statistics,
    }
}

assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(6, 9001, [321013]), ""),
    [3210132],
)
for (const category of [6, 13, 14, 20]) {
    assert.deepEqual(
        getMatchedAwakeDirectBattleMissionIds(directBattleContext(category, 9001, [321013]), ""),
        [3210132],
    )
}
for (const questId of [2001, 2002, 2003, 2004, 2005, 2006]) {
    assert.deepEqual(
        getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, questId, [321013]), ""),
        [3210132, 3210133],
    )
}
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 2001, [321013]), ""),
    [3210132, 3210133],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 2007, [321013]), ""),
    [3210132],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(14, 1, [], { unisonIds: [321013] }), ""),
    [3210132],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(20, 1, [321013], { isMulti: true }), ""),
    [],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(5, 9001, [321013]), ""),
    [],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 1040, [341001]), ""),
    [3410012, 3410013],
)
for (const category of [6, 13, 14, 20]) {
    assert.deepEqual(
        getMatchedAwakeDirectBattleMissionIds(directBattleContext(category, 9001, [341001]), ""),
        [3410012],
    )
}
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 1039, [341001]), ""),
    [3410012],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 1040, [341001], { isMulti: true }), ""),
    [],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(13, 1040, [999]), ""),
    [],
)

for (const missionId of [3210132, 3210133, 3410012, 3410013, 1610022, 2610072]) {
    assert.equal(AWAKE_DIRECT_BATTLE_MISSION_IDS.has(missionId), true)
}

const noDeathStatistics = { zones: [{ encoffin_count: 0 }, { encoffin_count: 0 }], continue_count: 99 }
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [161002], { statistics: noDeathStatistics }), ""),
    [],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [261007], { statistics: { zones: [{ encoffin_count: 0 }] } }), ""),
    [],
)
for (const statistics of [
    undefined,
    { zones: null },
    { zones: { length: 1 } },
    { zones: [null] },
    { zones: [] },
    { zones: [{ encoffin_count: 1 }] },
    { zones: [{ encoffin_count: -1 }] },
    { zones: [{ encoffin_count: 0.5 }] },
    { zones: [{ encoffin_count: NaN }] },
    { zones: [{ encoffin_count: Infinity }] },
]) {
    assert.deepEqual(
        getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [161002], { statistics }), ""),
        [],
    )
}
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [999, 161002], { statistics: noDeathStatistics }), ""),
    [],
)

const awakeDefs = require("../assets/mission_char_awake.json")
assert.equal(AWAKE_GENERIC_CHARACTER_CLEAR_RULES.length, 55)
for (const { missionId, characterId } of AWAKE_GENERIC_CHARACTER_CLEAR_RULES) {
    const row = awakeDefs[missionId][0]
    assert.equal(row[4], "93", `generic mission ${missionId} must use specific-character pattern`)
    assert.deepEqual(row.slice(5, 24), [
        "", "", "3", "", "(None)", "", "", "", "(None)",
        "(None)", "(None)", "(None)", "(None)", "", "", "(None)",
        "(None)", "(None)", "(None)",
    ])
    assert.equal(Number(row[1]), characterId)
    assert.equal(row[24], row[1], `generic mission ${missionId} must target its owning character`)
    assert.equal(row[25], "")
    assert.equal(row[26], "")
    assert.match(row[3], /^队伍中编有.+通关任意关卡(?::|::x_count::次)?$/)
    assert.doesNotMatch(row[3], /队长|共斗|限时|分钟|且|、|种族|连击|强化弹射|信赖/)
}

function battleFactContext({
    category = 1,
    questId = 1,
    ids = [],
    isMulti = false,
    accomplished = true,
    clearTime = 1000,
    statistics = {},
} = {}) {
    return {
        questCategory: category,
        questId,
        isMulti,
        questAccomplished: accomplished,
        clearTime,
        party: {
            characters: ids.map(id => ({ id })),
            unison_characters: [],
        },
        statistics,
    }
}

assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [1],
    statistics: { zones: [{ use_power_flip_count: 2 }, { use_power_flip_count: 3 }] },
})), {
    increments: [{ missionId: 13, delta: 5 }],
    maxima: [],
})
for (const context of [
    battleFactContext({ ids: [999, 1], statistics: { zones: [{ use_power_flip_count: 5 }] } }),
    battleFactContext({ ids: [1], accomplished: false, statistics: { zones: [{ use_power_flip_count: 5 }] } }),
    battleFactContext({ ids: [1], statistics: { zones: [{ use_power_flip_count: -1 }] } }),
]) {
    assert.deepEqual(getAwakeBattleProgressFacts(context), { increments: [], maxima: [] })
}
assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [121001],
    isMulti: true,
    statistics: { zones: [{ use_power_flip_count: 4 }] },
})), {
    increments: [{ missionId: 1210012, delta: 4 }],
    maxima: [],
})

assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [121001],
    statistics: { max_combo_count: 37 },
})), {
    increments: [],
    maxima: [{ missionId: 1210013, progress: 37 }],
})
assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [999, 121001],
    statistics: { max_combo_count: 999 },
})), { increments: [], maxima: [] })

assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [241063, 243007, 361009],
})), {
    increments: [{ missionId: 2410633, delta: 1 }],
    maxima: [],
})
assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
    ids: [241063, 243007],
})), { increments: [], maxima: [] })

for (const [missionIds, category, questId, leaderId, clearTime, isMulti] of [
    [[1110013], 2, 1028004, 111001, 1000, false],
    [[1310052], 15, 96, 131005, 1000, false],
    [[2110013], 2, 1028004, 211001, 1000, true],
    [[2310013], 2, 1010004, 231001, 90000, false],
    [[2510032, 2510033], 13, 1020, 251003, 1000, false],
    [[2510032, 2510033], 13, 1020, 251003, 180000, false],
    [[2630023], 19, 100100004, 151006, 1000, false],
]) {
    assert.deepEqual(getAwakeBattleProgressFacts(battleFactContext({
        category,
        questId,
        ids: [leaderId],
        clearTime,
        isMulti,
    })), {
        increments: missionIds.map(missionId => ({ missionId, delta: 1 })),
        maxima: [],
    })
}
for (const context of [
    battleFactContext({ category: 2, questId: 1028004, ids: [999, 111001] }),
    battleFactContext({ category: 2, questId: 1028005, ids: [111001] }),
    battleFactContext({ category: 2, questId: 1028004, ids: [111001], isMulti: true }),
    battleFactContext({ category: 2, questId: 1010004, ids: [231001], clearTime: 90001 }),
]) {
    assert.deepEqual(getAwakeBattleProgressFacts(context), { increments: [], maxima: [] })
}

assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [161002], {
        statistics: noDeathStatistics,
    }), ""),
    [],
    "statistics 17 lacks an authoritative field mapping and must fail closed",
)

const awakeComputer = getComputer(9)
assert.equal(awakeComputer.compute(2110012, {
    coClears: new Map([["211001_231001", 5]]),
}, 0), 5)
assert.equal(awakeComputer.compute(2310012, {
    categoryMissionProgress: new Map([[2310012, 2]]),
}, 0), 2)

const directProgressContext = {
    categoryMissionProgress: new Map([[3310032, 1]]),
    coClears: new Map([["1_331003", 99]]),
}
assert.equal(awakeComputer.compute(3310032, directProgressContext, 0), 1)
assert.equal(awakeComputer.compute(3310033, directProgressContext, 0), 0)
assert.equal(awakeComputer.compute(3210132, {
    categoryMissionProgress: new Map([[3210132, 4]]),
    charClears: new Map([["321013", 99]]),
}, 0), 4)
assert.equal(awakeComputer.compute(1610022, {
    categoryMissionProgress: new Map([[1610022, 2]]),
    leaderClears: new Map([["161002", 99]]),
}, 0), 2)
for (const [missionId, directProgress, fallbackKey] of [
    [3210133, 3, "321013"],
    [3410012, 4, "341001"],
    [3410013, 5, "341001"],
    [2610072, 6, "261007"],
    [1510062, 7, "151006"],
]) {
    assert.equal(awakeComputer.compute(missionId, {
        categoryMissionProgress: new Map([[missionId, directProgress]]),
        charClears: new Map([[fallbackKey, 99]]),
        leaderClears: new Map([[fallbackKey, 98]]),
    }, 0), directProgress)
}

assert.equal(awakeComputer.compute(1410033, {
    charData: new Map([["141003", { bondTokenList: [] }]]),
}, 0), 0)

assert.equal(awakeComputer.compute(13, {
    categoryMissionProgress: new Map([[13, 4]]),
    player: { totalPowerflips: 999 },
}, 0), 4)
assert.equal(awakeComputer.compute(1210013, {
    categoryMissionProgress: new Map([[1210013, 37]]),
    player: { maxComboAchieved: 999 },
}, 0), 37)
assert.equal(awakeComputer.compute(2410633, {
    categoryMissionProgress: new Map(),
    coClears: new Map([
        ["241063_243007", 5],
        ["241063_361009", 5],
        ["243007_361009", 5],
    ]),
}, 0), 0)
assert.equal(awakeComputer.compute(2310013, {
    categoryMissionProgress: new Map(),
    questProgress: {
        2: [
            { questId: 1010004, finished: true, bestElapsedTimeMs: 80000, leaderCharacterId: 999 },
            { questId: 1010005, finished: true, bestElapsedTimeMs: 70000, leaderCharacterId: 231001 },
        ],
    },
}, 0), 0)
assert.equal(awakeComputer.compute(2310013, {
    categoryMissionProgress: new Map(),
    questProgress: {},
}, 2), 2, "existing persisted progress remains the lower bound")

console.log("character awake fact tests passed")
