const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const { convertQuestTree } = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(projectRoot, "..")
const rawRoot = path.join(workspaceRoot, "wf-assets-cn", "orderedmap")
const rawQuests = JSON.parse(fs.readFileSync(
    path.join(rawRoot, "quest/event/hard_multi_event_quest.json"),
    "utf8",
))
const clearRewards = require(path.join(projectRoot, "assets/clear_reward.json"))
const bundledQuests = require(path.join(projectRoot, "assets/hard_multi_event_quest.json"))

function flattenRows(source) {
    return Object.values(source).flatMap(stages => Object.values(stages).flatMap(wrappers => (
        wrappers.map(wrapper => wrapper)
    )))
}

const rawRows = flattenRows(rawQuests)
assert.equal(rawRows.length, 12)

const converterOutput = convertQuestTree("hard_multi_event_quest.json", rawQuests)

for (const row of rawRows) {
    const questId = String(row[0])
    assert.equal(converterOutput[questId].clearRewardId, Number(row[4]))
    assert.equal(converterOutput[questId].sPlusRewardId, Number(row[72]))
    assert.equal(converterOutput[questId].rankPointReward, Number(row[94]))
    assert.equal(converterOutput[questId].characterExpReward, Number(row[95]))
    assert.equal(converterOutput[questId].manaReward, Number(row[96]))
    assert.equal(converterOutput[questId].poolExpReward, Number(row[97]))
}

for (const questId of ["100002001", "1006001"]) {
    assert.equal(converterOutput[questId].periodicRewardGroupId, 10000002)
    assert.equal(converterOutput[questId].periodicRewardSlots, 1)
}

assert.deepEqual(bundledQuests, converterOutput)

const missingRewardReferences = []
for (const fileName of fs.readdirSync(path.join(projectRoot, "assets"))) {
    if (!fileName.endsWith("_quest.json")) continue
    const table = require(path.join(projectRoot, "assets", fileName))
    for (const [questId, quest] of Object.entries(table)) {
        for (const field of ["clearRewardId", "sPlusRewardId"]) {
            const rewardId = quest[field]
            if (rewardId !== undefined && clearRewards[String(rewardId)] === undefined) {
                missingRewardReferences.push(`${fileName}:${questId}:${field}=${rewardId}`)
            }
        }
    }
}
assert.deepEqual(missingRewardReferences, [])

console.log("hard multi event quest data tests passed")
