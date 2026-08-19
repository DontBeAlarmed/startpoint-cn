"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const bundledMissions = require("../assets/mission_active.json")
const bundledEvents = require("../assets/mission_active_event.json")
const bundledRewards = require("../assets/mission_active_reward.json")
const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")
const { parseActiveMissionEventDefinition } = require("../src/lib/mission/active-plan")
const { getActiveMissionRewards } = require("../src/lib/mission/rewards")

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function repository(tables) {
    return {
        info: () => ({
            source: "release",
            assetVersion: "active-plan-test",
            generatorVersion: 1,
            releaseDigest: "active-plan-test",
        }),
        table: tableName => tables[tableName],
    }
}

const repositoryA = repository({
    "mission_active.json": clone(bundledMissions),
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
})
const repositoryB = repository({
    "mission_active.json": clone(bundledMissions),
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
})

const first = getActiveMissionPlan(repositoryA)
const again = getActiveMissionPlan(repositoryA)
const other = getActiveMissionPlan(repositoryB)
assert.equal(first, again)
assert.notEqual(first, other)
assert.equal(first.getMission(11010).missionId, 11010)
assert.equal(first.getDefinitionsByPattern(23).length, 19)
assert.deepEqual(first.getUnsupportedMissionIds(), [21030, 25009, 25010, 25011, 25012, 25013, 25014, 25017, 25018, 25022])

for (const stringId of ["", "(None)"]) {
    const row = clone(bundledEvents["1"][0])
    row[0] = stringId
    assert.equal(parseActiveMissionEventDefinition(1, row).stringId, stringId)
}

const copiedRewards = getActiveMissionRewards(11010, 1, repositoryA)
assert.equal(copiedRewards[0].amount, 5)
copiedRewards[0].amount = 999999
copiedRewards[0].itemId = 999999
assert.deepEqual(getActiveMissionRewards(11010, 1, repositoryA), [
    { kind: 1, amount: 5, itemId: 101 },
])

const duplicateMissionTables = {
    "mission_active.json": {
        1: bundledMissions["11010"],
        "01": bundledMissions["11020"],
    },
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
}
assert.throws(
    () => getActiveMissionPlan(repository(duplicateMissionTables)),
    /duplicate/i,
)

function expectPlanError(mutate, pattern) {
    const tables = {
        "mission_active.json": clone(bundledMissions),
        "mission_active_event.json": clone(bundledEvents),
        "mission_active_reward.json": clone(bundledRewards),
    }
    mutate(tables)
    assert.throws(
        () => getActiveMissionPlan(repository(tables)),
        error => pattern.test(String(error?.message))
            && /mission_active(?:_event|_reward)?\.json/i.test(String(error?.message)),
    )
}

expectPlanError(tables => {
    tables["mission_active.json"].invalid = bundledMissions["11010"]
}, /mission_active\.json.*invalid/i)

expectPlanError(tables => {
    tables["mission_active.json"]["11010"] = ["invalid row"]
}, /mission_active\.json.*11010/i)

expectPlanError(tables => {
    tables["mission_active.json"]["01"] = bundledMissions["11010"]
}, /mission_active\.json.*01/i)

expectPlanError(tables => {
    tables["mission_active.json"]["11010"][0][3] = null
}, /mission_active\.json.*11010/i)

expectPlanError(tables => {
    tables["mission_active_event.json"]["1"][0][14] = "invalid time"
}, /mission_active_event\.json.*1/i)

expectPlanError(tables => {
    tables["mission_active_reward.json"]["11010"]["1"][0][3] = "invalid target"
}, /mission_active_reward\.json.*11010/i)

expectPlanError(tables => {
    tables["mission_active.json"]["11010"][0][0] = "999999"
}, /mission_active\.json.*11010.*event/i)

expectPlanError(tables => {
    delete tables["mission_active_reward.json"]["11010"]
}, /mission_active_reward\.json.*11010/i)

expectPlanError(tables => {
    delete tables["mission_active.json"]["11010"][0][29]
}, /mission_active\.json.*11010.*pattern/i)

for (const invalidPattern of ["", null]) {
    expectPlanError(tables => {
        tables["mission_active.json"]["11010"][0][29] = invalidPattern
    }, /mission_active\.json.*11010.*pattern/i)
}

for (const invalidKind of ["", null]) {
    expectPlanError(tables => {
        tables["mission_active_event.json"]["1"][0][2] = invalidKind
    }, /mission_active_event\.json.*1.*kind/i)
}

for (const invalidTargetProgress of ["", null]) {
    expectPlanError(tables => {
        tables["mission_active_reward.json"]["11010"]["1"][0][3] = invalidTargetProgress
    }, /mission_active_reward\.json.*11010.*target progress/i)
}

for (const invalidAmount of ["", null, "(None)"]) {
    expectPlanError(tables => {
        tables["mission_active_reward.json"]["11010"]["1"][0][8] = invalidAmount
    }, /mission_active_reward\.json.*11010.*rewards/i)
}

const zeroAmountTables = {
    "mission_active.json": clone(bundledMissions),
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
}
const zeroAmountReward = zeroAmountTables["mission_active_reward.json"]["11010"]["1"][0]
zeroAmountReward[7] = "6"
zeroAmountReward[8] = "0"
zeroAmountReward[12] = "123456"
const zeroAmountPlan = getActiveMissionPlan(repository(zeroAmountTables))
assert.deepEqual(
    zeroAmountPlan.getMission(11010).rewardStages[0].rewards,
    [{ kind: 6, amount: 0, itemId: 101, degreeId: 123456 }],
    "合法的 amount=0 reward 必须构建成功并保留",
)

expectPlanError(tables => {
    tables["mission_active_event.json"]["01"] = clone(bundledEvents["1"])
}, /duplicate.*mission_active_event\.json.*1/i)

expectPlanError(tables => {
    tables["mission_active_reward.json"]["11010"]["01"] = clone(
        tables["mission_active_reward.json"]["11010"]["1"],
    )
}, /mission_active_reward\.json.*11010.*duplicate/i)

const retryTables = {
    "mission_active.json": clone(bundledMissions),
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
}
const retryRepository = repository(retryTables)
retryTables["mission_active.json"]["11010"][0][29] = null
assert.throws(
    () => getActiveMissionPlan(retryRepository),
    /mission_active\.json.*11010.*pattern/i,
)
retryTables["mission_active.json"]["11010"][0][29] = bundledMissions["11010"][0][29]
const recoveredPlan = getActiveMissionPlan(retryRepository)
assert.notEqual(recoveredPlan, first)
assert.equal(recoveredPlan.getMission(11010).pattern, first.getMission(11010).pattern)

for (const definition of first.getDefinitionsByPattern(70)) {
    assert.deepEqual(
        definition.factKinds,
        definition.questRange === null ? ["characterClear"] : [],
        `pattern 70 mission ${definition.missionId} must only load its actual fact domain`,
    )
}

const expectedFactKinds = new Map([
    [0, ["player"]], [4, ["characters"]], [5, ["characters"]], [7, ["manaNodes"]],
    [8, ["characters"]], [9, ["characters"]], [13, []], [14, ["battleCounters"]],
    [16, ["battleCounters"]], [17, ["battleCounters"]], [21, ["characters"]], [23, []],
    [26, ["battleCounters"]], [34, ["equipment"]], [35, ["party"]], [36, ["equipment"]],
    [39, ["player"]], [45, ["shopPurchases"]], [46, ["counters"]], [48, ["manaNodes"]],
    [57, []], [58, ["counters"]], [59, ["counters"]], [60, ["counters"]],
    [61, ["characters"]], [62, ["manaNodes"]], [63, ["counters"]], [64, ["shopPurchases"]],
    [65, ["counters"]], [66, []], [71, ["conditionalBattleFacts"]],
    [72, ["conditionalBattleFacts"]], [73, ["conditionalBattleFacts"]], [78, ["counters"]],
    [83, ["counters"]], [84, ["shopPurchases"]], [89, ["missionSpecificBattleFacts"]],
    [90, ["missionSpecificBattleFacts"]], [91, ["missionSpecificBattleFacts"]],
])
for (const definition of first.definitions) {
    const factKinds = definition.pattern === 70
        ? definition.questRange === null ? ["characterClear"] : []
        : expectedFactKinds.get(definition.pattern)
    assert.deepEqual(definition.factKinds, factKinds ?? [], `pattern ${definition.pattern}`)
    assert.equal(
        definition.evaluator,
        factKinds === undefined ? null : definition.pattern === 13 ? "dependency" : "static",
        `pattern ${definition.pattern}`,
    )
}

const unknownPatternTables = {
    "mission_active.json": clone(bundledMissions),
    "mission_active_event.json": clone(bundledEvents),
    "mission_active_reward.json": clone(bundledRewards),
}
unknownPatternTables["mission_active.json"]["11010"][0][29] = "999"
const unknownPatternPlan = getActiveMissionPlan(repository(unknownPatternTables))
assert.deepEqual(unknownPatternPlan.getMission(11010).factKinds, [])
assert.equal(unknownPatternPlan.getMission(11010).evaluator, null)

console.log("active mission plan tests passed")
