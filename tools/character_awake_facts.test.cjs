require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    AWAKE_RACE_MISSION_KEYS,
    AWAKE_DIRECT_BATTLE_MISSION_IDS,
    getMatchedAwakeDirectBattleMissionIds,
    getMatchedAwakeRaceMissionIds,
    getMatchedAwakeQuestPartyMissionIds,
    isBondTokenMissionComplete,
    mergePartyCoClearRows,
    normalizeCharacterPair,
} = require("../src/lib/mission/awake-battle-rules")
const { getRaceKeyString } = require("../src/lib/quest/finish/race-utils")
const { getComputer } = require("../src/lib/mission")

assert.deepEqual(normalizeCharacterPair(231001, 211001), [211001, 231001])
assert.deepEqual(
    mergePartyCoClearRows([
        { char_id_a: 211001, char_id_b: 231001, co_clear_count: 2 },
        { char_id_a: 231001, char_id_b: 211001, co_clear_count: 3 },
    ]),
    new Map([["211001_231001", 5]]),
)

const expectedRaceKey = getRaceKeyString(["Human", "Dragon", "Devil"])
assert.equal(AWAKE_RACE_MISSION_KEYS.get(2310012), expectedRaceKey)
assert.equal(expectedRaceKey.includes("Beast"), false)
assert.deepEqual(
    getMatchedAwakeRaceMissionIds(
        questPartyContext(1, 1, [231001, 1, 999]),
        expectedRaceKey,
    ),
    [2310012],
)
assert.deepEqual(
    getMatchedAwakeRaceMissionIds(
        questPartyContext(1, 1, [1, 231001, 999]),
        expectedRaceKey,
    ),
    [],
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
    [1610022],
)
assert.deepEqual(
    getMatchedAwakeDirectBattleMissionIds(directBattleContext(1, 1, [261007], { statistics: { zones: [{ encoffin_count: 0 }] } }), ""),
    [2610072],
)
for (const statistics of [
    undefined,
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

const storyMissionIds = new Set(Object.entries(require("../assets/mission_char_awake.json"))
    .filter(([, rows]) => /阅读|剧情/.test(rows[0][3]))
    .map(([missionId]) => Number(missionId)))
const slotFourMissionIds = new Set(Object.keys(require("../assets/mission_char_awake.json"))
    .map(Number)
    .filter(missionId => missionId % 10 === 4))
const existingExplicitMissionIds = new Set([
    12, 13,
    1110013, 1210012, 1210013, 1310052, 1310053, 1410032, 1410033,
    1510062, 1510063, 1610023, 2110012, 2110013, 2210042, 2210043,
    2310012, 2310013,
    2410632, 2410633, 2510032, 2510033, 2510042, 2510043, 2610073,
    2630022, 2630023, 3310032, 3310033,
])
const directAwakeMissionIds = new Set([3210132, 3210133, 3410012, 3410013, 1610022, 2610072])
const awakeDefs = require("../assets/mission_char_awake.json")
const awakeFallbackMissionIds = Object.keys(require("../assets/mission_char_awake.json"))
    .map(Number)
    .filter(missionId => !storyMissionIds.has(missionId))
    .filter(missionId => !slotFourMissionIds.has(missionId))
    .filter(missionId => !existingExplicitMissionIds.has(missionId))
    .filter(missionId => !directAwakeMissionIds.has(missionId))
assert.equal(awakeFallbackMissionIds.length, 55)
for (const missionId of awakeFallbackMissionIds) {
    const row = awakeDefs[missionId][0]
    assert.equal(row[4], "93", `fallback mission ${missionId} must use specific-character pattern`)
    assert.deepEqual(row.slice(5, 24), [
        "", "", "3", "", "(None)", "", "", "", "(None)",
        "(None)", "(None)", "(None)", "(None)", "", "", "(None)",
        "(None)", "(None)", "(None)",
    ])
    assert.equal(row[24], row[1], `fallback mission ${missionId} must target its character_ids field`)
    assert.match(row[3], /^队伍中编有.+通关任意关卡(?::|::x_count::次)?$/)
    assert.doesNotMatch(row[3], /队长|共斗|限时|分钟|且|、|种族|连击|强化弹射|信赖/)
}

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

console.log("character awake fact tests passed")
