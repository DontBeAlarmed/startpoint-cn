"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function assertSettlementInsideFinishTransaction(source, label) {
    const transactionBody = source.indexOf("const executeFinishWrites = () => {")
    const settlement = source.indexOf("settleAdditionalRewardsSync(", transactionBody)
    const transactionCommit = source.indexOf("getDb().transaction(executeFinishWrites)()", settlement)

    assert.ok(transactionBody >= 0, `${label} must define a finish transaction`)
    assert.ok(settlement > transactionBody, `${label} must settle additional rewards in the transaction`)
    assert.ok(transactionCommit > settlement, `${label} must commit after additional rewards settle`)
}

test("single finish grants and publishes additional rewards atomically", () => {
    const source = readSource("src/routes/api/singleBattleQuest.ts")
    assertSettlementInsideFinishTransaction(source, "single finish")
    assert.match(source, /settleAdditionalRewardsSync\([\s\S]*?isMulti: false,/)
    assert.match(
        source,
        /\.\.\.\(additionalRewardSettlement\.rewardResult\?\.items \?\? \{\}\),/,
    )
    assert.match(
        source,
        /"drop_additional_reward_ids": additionalRewardSettlement\.dropAdditionalRewardIds/,
    )
})

test("multi finish enables multi-only rules and publishes additional rewards atomically", () => {
    const source = readSource("src/multi/http/battle.ts")
    assertSettlementInsideFinishTransaction(source, "multi finish")
    assert.match(source, /settleAdditionalRewardsSync\([\s\S]*?isMulti: true,/)
    assert.match(
        source,
        /"item_list": \{[\s\S]*?additionalRewardSettlement\.rewardResult\?\.items/,
    )
    assert.match(
        source,
        /"drop_additional_reward_ids": additionalRewardSettlement\.dropAdditionalRewardIds/,
    )
})
