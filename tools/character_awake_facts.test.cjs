require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    AWAKE_RACE_MISSION_KEYS,
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

assert.equal(isBondTokenMissionComplete([]), false)
assert.equal(isBondTokenMissionComplete([{ status: 2 }, { status: 3 }]), true)
assert.equal(isBondTokenMissionComplete([{ status: 2 }, { status: 1 }]), false)

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

assert.equal(awakeComputer.compute(1410033, {
    charData: new Map([["141003", { bondTokenList: [] }]]),
}, 0), 0)

console.log("character awake fact tests passed")
