"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const {
    convertPeriodicRewardTrees,
    PERIODIC_REWARD_TABLE_SOURCES,
} = require("../src/content/converters/periodic-reward")
const { convertQuestTree } = require("../src/content/converters/quest")
const { findTableSource } = require("../src/content/sync/table-registry")

const projectRoot = path.resolve(__dirname, "..")
const rawRoot = path.join(projectRoot, "..", "wf-assets-cn", "orderedmap")

function readOrderedMapJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(rawRoot, relativePath), "utf8"))
}

const hardMultiEvents = readOrderedMapJson("quest/event/hard_multi_event.json")
const hardMultiQuests = readOrderedMapJson("quest/event/hard_multi_event_quest.json")
const bossBattleQuests = readOrderedMapJson("quest/boss_battle_quest.json")
const periodicRewards = readOrderedMapJson("reward/periodic_reward.json")
const periodicRewardPoints = readOrderedMapJson("reward/periodic_reward_point.json")

const converted = convertPeriodicRewardTrees({
    hardMultiEvents,
    periodicRewards,
    periodicRewardPoints,
})

const unsupportedRewardKind = structuredClone(periodicRewards)
unsupportedRewardKind["10000002"]["1"][0][1] = "1"
assert.throws(
    () => convertPeriodicRewardTrees({
        hardMultiEvents,
        periodicRewards: unsupportedRewardKind,
        periodicRewardPoints,
    }),
    /invalid periodic reward content.*kind.*must be 0/i,
)
const convertedHardMultiQuests = convertQuestTree(
    "hard_multi_event_quest.json",
    hardMultiQuests,
)

assert.equal(converted["periodic_reward_point.json"]["10000002"].maxPoint, 99)
assert.equal(converted["periodic_reward_point.json"]["10000002"].recoveryPoint, 2)
assert.equal(converted["periodic_reward_point.json"]["10000002"].recoveryCycle, 0)
assert.deepEqual(converted["periodic_reward.json"]["10000002"]["1"], {
    kind: 0,
    itemId: 40405,
    count: 9,
    probability: 1,
})
assert.equal(converted["hard_multi_event.json"]["100002"].periodicPointId, 10000002)
assert.equal(converted["hard_multi_event.json"]["1006"].periodicPointId, undefined)

assert.equal(convertedHardMultiQuests["1066001"], undefined)
assert.ok(Object.values(bossBattleQuests)
    .flatMap(groups => Object.values(groups))
    .flatMap(stages => Object.values(stages))
    .flat()
    .some(row => row[0] === "1066001"))

for (const [tableName, source] of Object.entries(PERIODIC_REWARD_TABLE_SOURCES)) {
    const definition = findTableSource(tableName)
    assert.equal(definition.converterId, "periodic-reward", tableName)
    assert.deepEqual(definition.sourceOrderedMaps, [source.logicalPath], tableName)
}

console.log("periodic reward content tests passed")
