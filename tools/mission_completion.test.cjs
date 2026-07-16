const assert = require("node:assert/strict")

const {
    getComputer,
    getCompletedStageNumbers,
    getActiveMissionRewards,
    getDailyMissionRewards,
    isMissionProgressComplete,
    getRegularMissionRewards,
    getWeeklyMissionRewards,
    isMissionEnabledAt,
    validateMissionRewardClaims,
} = require("../out/lib/mission")
const { addMissionProgressDelta } = require("../out/lib/mission/progress")

assert.equal(getComputer(10).name, "Regular")
assert.deepEqual(getCompletedStageNumbers(1, 1, 0), [])
assert.deepEqual(getCompletedStageNumbers(1, 1, 10), [1])
assert.equal(typeof isMissionProgressComplete, "function")
assert.equal(isMissionProgressComplete(9, 3410051, 1), true)
assert.equal(isMissionProgressComplete(9, 3410052, 1), false)
assert.equal(isMissionProgressComplete(9, 3410052, 3), true)
assert.equal(isMissionProgressComplete(9, 3410053, 1), false)
assert.equal(isMissionProgressComplete(9, 3410053, 5), true)

const awakeComputer = getComputer(9)
assert.equal(awakeComputer.compute(3410054, { charClears: new Map([["341005", 1]]) }, 0), 1)
assert.equal(awakeComputer.compute(3410054, { charClears: new Map([["341005", 3]]) }, 0), 2)
assert.equal(awakeComputer.compute(3410054, { charClears: new Map([["341005", 5]]) }, 0), 3)

assert.equal(
    isMissionEnabledAt(2, 3, new Date("2019-11-28T02:59:59.999Z")),
    false
)
assert.equal(
    isMissionEnabledAt(2, 3, new Date("2019-11-28T03:00:00.000Z")),
    true
)
assert.equal(
    isMissionEnabledAt(4, 1500, new Date("2020-02-25T03:00:00.000Z"), 1),
    true
)
assert.equal(
    isMissionEnabledAt(4, 1500, new Date("2020-02-25T03:00:00.000Z"), 2),
    false
)

assert.equal(addMissionProgressDelta(4, 3), 7)
assert.equal(addMissionProgressDelta(4, 0), null)
assert.equal(addMissionProgressDelta(4, -1), null)
assert.equal(addMissionProgressDelta(4, 1.5), null)

assert.deepEqual(getRegularMissionRewards(1, 1), [{ kind: 0, amount: 5 }])
assert.deepEqual(getDailyMissionRewards(1, 1), [{ kind: 0, amount: 5 }])
assert.deepEqual(getWeeklyMissionRewards(1, 1), [{ kind: 1, amount: 500, itemId: 70047 }])
assert.deepEqual(getActiveMissionRewards(20001, 1), [
    { kind: 4, amount: 1, characterId: 121033 },
    { kind: 4, amount: 1, characterId: 121007 },
    { kind: 2, amount: 5, equipmentId: 5080018 },
    { kind: 2, amount: 5, equipmentId: 5030029 },
])

const incompleteClaim = validateMissionRewardClaims(
    { 11110: { progress: 9, stages: [] } },
    [{ mission_id: 11110, stages: [1] }]
)
assert.deepEqual(incompleteClaim, { ok: false, message: "Mission stage is not complete." })

const validClaim = validateMissionRewardClaims(
    { 11110: { progress: 10, stages: [] } },
    [{ mission_id: 11110, stages: [1, 1] }]
)
assert.equal(validClaim.ok, true)
assert.equal(validClaim.claims.length, 1)
assert.deepEqual(validClaim.claims[0].rewards, [{ kind: 0, amount: 300 }])

const alreadyReceived = validateMissionRewardClaims(
    { 11110: { progress: 10, stages: { 1: true } } },
    [{ mission_id: 11110, stages: [1] }]
)
assert.deepEqual(alreadyReceived, { ok: true, claims: [] })

console.log("mission completion tests passed")
