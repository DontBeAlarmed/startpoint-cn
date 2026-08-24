"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function assertSettlementInsideFinishTransaction(
    source,
    label,
    transactionCall,
    transactionBodyCall = "const executeFinishWrites =",
) {
    const transactionBody = source.indexOf(transactionBodyCall)
    const settlement = source.indexOf("settleAdditionalRewardsSync(", transactionBody)
    const transactionCommit = source.indexOf(transactionCall, settlement)

    assert.ok(transactionBody >= 0, `${label} must define a finish transaction`)
    assert.ok(settlement > transactionBody, `${label} must settle additional rewards in the transaction`)
    assert.ok(transactionCommit > settlement, `${label} must commit after additional rewards settle`)
}

test("single finish grants and publishes additional rewards atomically", () => {
    const orchestrator = readSource("src/lib/quest/finish/single-orchestrator.ts")
    const writes = readSource("src/lib/quest/finish/single-settlement-writes.ts")
    const projector = readSource("src/lib/quest/finish/single-response-projector.ts")
    const writesStart = writes.indexOf("export function executeSingleSettlementWrites(")
    const settlement = writes.indexOf("settleAdditionalRewardsSync(", writesStart)
    assert.ok(writesStart >= 0, "single finish must define focused settlement writes")
    assert.ok(settlement > writesStart, "single additional rewards must settle in writes")
    assert.match(
        orchestrator,
        /runSingleFinishSettlementTransaction\(\{[\s\S]*?settle:\s*\(\{ activeQuest, player, questProgress \}\) => \{[\s\S]*?executeSingleSettlementWrites\(/,
    )
    assert.match(writes, /settleAdditionalRewardsSync\([\s\S]*?isMulti: false,/)
    assert.match(writes, /const grantDirectRewards = responseState\.grant/)
    assert.match(
        writes,
        /grantRewards:\s*rewards\s*=>\s*grantDirectRewards\(playerId,\s*"additional",\s*rewards\)/,
    )
    assert.match(
        projector,
        /"drop_additional_reward_ids": additionalRewardSettlement\.dropAdditionalRewardIds/,
    )
})

test("multi finish enables multi-only rules and publishes additional rewards atomically", () => {
    const orchestrator = readSource("src/multi/settlement/orchestrator.ts")
    const response = readSource("src/multi/settlement/response.ts")
    assertSettlementInsideFinishTransaction(
        orchestrator,
        "multi finish",
        "runMultiActiveQuestSettlementTransaction(",
    )
    assert.match(orchestrator, /settleAdditionalRewardsSync\([\s\S]*?isMulti: true,/)
    assert.match(
        response,
        /"item_list": \{[\s\S]*?additionalRewardSettlement\.rewardResult\?\.items/,
    )
    assert.match(
        response,
        /"drop_additional_reward_ids": additionalRewardSettlement\.dropAdditionalRewardIds/,
    )
})
