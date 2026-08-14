require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "../src/lib/quest.ts"), "utf8")
const functionStart = source.indexOf("export function givePlayerScoreRewardsSync(")
const functionEnd = source.indexOf("/**\n * Batch gives", functionStart)
const functionSource = source.slice(functionStart, functionEnd)

test("formats score reward counts, rare groups and inventory totals as one line", () => {
    let formatters
    assert.doesNotThrow(() => {
        formatters = require("../src/lib/hot-path-log-formatters")
    })
    assert.equal(typeof formatters.formatQuestScoreRewardsSummary, "function")

    const message = formatters.formatQuestScoreRewardsSummary({
        playerId: 7,
        groupId: 8001,
        commonDrops: [{ group_id: 8001, index: 2, number: 4 }],
        rareDrops: [
            { group_id: 3014, index: 1, number: 3 },
            { group_id: 3013, index: 2, number: 3 },
        ],
        inventoryTotals: { "16": 3, "400002": 4 },
    })

    assert.equal(
        message,
        '[QUEST] score_rewards playerId=7 groupId=8001 common=1 rare=2 drops=[{"index":2,"number":4}] rareDrops=[{"group_id":3014,"index":1,"number":3},{"group_id":3013,"index":2,"number":3}] inventoryTotals={"16":3,"400002":4}',
    )
    assert.equal(message.includes("\n"), false)
})

test("score reward settlement emits one sampled lazy summary instead of per-reward logs", () => {
    assert.doesNotMatch(functionSource, /QUEST-(?:ITEM|ELEMENT|AETHER|BAG)/)
    assert.doesNotMatch(functionSource, /givePlayerScoreRewards group=/)
    assert.equal(functionSource.match(/sampledLog\("quest-score-rewards"/g)?.length, 1)

    const sampledCall = functionSource.indexOf('sampledLog("quest-score-rewards"')
    const factory = functionSource.indexOf("() =>", sampledCall)
    const formatter = functionSource.indexOf("formatQuestScoreRewardsSummary", sampledCall)
    assert(sampledCall >= 0)
    assert(factory > sampledCall)
    assert(formatter > factory)
    assert.equal(functionSource.match(/formatQuestScoreRewardsSummary\(/g)?.length, 1)
    assert.doesNotMatch(functionSource, /dropScoreRewardIds\.map|JSON\.stringify/)
    assert(!functionSource.slice(sampledCall).includes("\\n"), "summary should stay on one line")
})
