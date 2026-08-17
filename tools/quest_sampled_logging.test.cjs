require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "../src/lib/quest.ts"), "utf8")
const functionStart = source.indexOf("export function givePlayerScoreRewardsSync(")
const functionEnd = source.indexOf("/**\n * Batch gives", functionStart)
const functionSource = source.slice(functionStart, functionEnd)
const settlementSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/score-reward-settlement.ts"),
    "utf8",
)
const selectionSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/score-reward-selection.ts"),
    "utf8",
)
const singleWritesSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-settlement-writes.ts"),
    "utf8",
)
const singleOrchestratorSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-orchestrator.ts"),
    "utf8",
)

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
    assert.doesNotMatch(selectionSource, /sampledLog|formatQuestScoreRewardsSummary/)
    assert.doesNotMatch(settlementSource, /QUEST-(?:ITEM|ELEMENT|AETHER|BAG)/)
    assert.doesNotMatch(settlementSource, /givePlayerScoreRewards group=/)
    assert.match(settlementSource, /from "\.\/score-reward-projection"/)
    assert.doesNotMatch(
        settlementSource,
        /import\s+\{\s*projectScoreRewardDropIds[^\n]*from "\.\/score-reward-selection"/,
    )
    assert.equal(settlementSource.match(/sampledLog\("quest-score-rewards"/g)?.length, 1)
    assert.equal(functionSource.match(/recordScoreRewardSettlement\s*\(/g)?.length, 1)
    assert.equal(singleWritesSource.match(/recordScoreRewardSettlement\s*\(/g)?.length ?? 0, 0)
    assert.equal(singleOrchestratorSource.match(/recordScoreRewardSettlement\s*\(/g)?.length, 1)

    const transactionCall = singleOrchestratorSource.indexOf(
        "settlement = runSingleFinishSettlementTransaction(",
    )
    const postCommitLog = singleOrchestratorSource.indexOf("recordScoreRewardSettlement(")
    assert(transactionCall >= 0)
    assert(postCommitLog > transactionCall)

    const sampledCall = settlementSource.indexOf('sampledLog("quest-score-rewards"')
    const factory = settlementSource.indexOf("() =>", sampledCall)
    const formatter = settlementSource.indexOf("formatQuestScoreRewardsSummary", sampledCall)
    assert(sampledCall >= 0)
    assert(factory > sampledCall)
    assert(formatter > factory)
    assert.equal(settlementSource.match(/formatQuestScoreRewardsSummary\(/g)?.length, 1)
    assert.doesNotMatch(settlementSource, /dropScoreRewardIds\.map|JSON\.stringify/)
    assert(!settlementSource.slice(sampledCall).includes("\\n"), "summary should stay on one line")
})
