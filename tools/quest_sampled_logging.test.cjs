const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "../src/lib/quest.ts"), "utf8")
const functionStart = source.indexOf("export function givePlayerScoreRewardsSync(")
const functionEnd = source.indexOf("/**\n * Batch gives", functionStart)
const functionSource = source.slice(functionStart, functionEnd)

test("score reward settlement emits one sampled lazy summary instead of per-reward logs", () => {
    assert.doesNotMatch(functionSource, /QUEST-(?:ITEM|ELEMENT|AETHER|BAG)/)
    assert.doesNotMatch(functionSource, /givePlayerScoreRewards group=/)
    assert.equal(functionSource.match(/sampledLog\("quest-score-rewards"/g)?.length, 1)

    const sampledCall = functionSource.indexOf('sampledLog("quest-score-rewards"')
    const factory = functionSource.indexOf("() =>", sampledCall)
    const mappedDrops = functionSource.indexOf("dropScoreRewardIds.map", sampledCall)
    const stringifiedItems = functionSource.indexOf("JSON.stringify(items)", sampledCall)
    assert(sampledCall >= 0)
    assert(factory > sampledCall)
    assert(mappedDrops > factory)
    assert(stringifiedItems > factory)
    assert(!functionSource.slice(sampledCall).includes("\\n"), "summary should stay on one line")

    for (const detail of [
        "playerId",
        "groupId",
        "dropScoreRewardIds.length",
        "dropRareRewardIds.length",
        "index",
        "number",
    ]) {
        assert(functionSource.slice(sampledCall).includes(detail), `summary should include ${detail}`)
    }
})
