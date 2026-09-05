const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

function routeSource(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8")
}

const sharedValues = routeSource("src/lib/quest/finish/battle-settlement-values.ts")
for (const [name, settlementPath, valueAdapterPath, responsePath] of [
    ["单人", "src/lib/quest/finish/single-settlement-writes.ts", "src/lib/quest/finish/single-settlement-value-plan.ts", "src/lib/quest/finish/single-response-projector.ts"],
    ["联机", "src/multi/settlement/orchestrator.ts", "src/multi/settlement/value-plan.ts", "src/multi/settlement/response.ts"],
]) {
    test(`${name}结算复用同一服务器时间并接入奖励活动倍率`, () => {
        const source = routeSource(settlementPath)
        const valueAdapter = routeSource(valueAdapterPath)
        const responseSource = routeSource(responsePath)
        assert.match(valueAdapter, /const settlementTime = new Date\(getServerTime\(\) \* 1000\)/)
        assert.match(
            valueAdapter,
            /getRewardCampaignRates\([\s\S]*?settlementTime,?\s*\)/,
        )
        assert.match(valueAdapter, /createBattleSettlementValuePlan\s*\(/)
        assert.match(sharedValues, /calculateFixedQuestMana\s*\(/)
        assert.match(sharedValues, /calculateFixedQuestPoolExp\s*\(/)
        assert.match(sharedValues, /calculateCharacterBattleExp\s*\(/)
        assert.match(source, /\{\s*settlementTime,\s*valuePlan\s*\}/)
        assert.match(source, /rewardCampaignRates[,\n]/)
        assert.match(source, /rewardDate:\s*settlementTime/)
        assert.match(source, /recordMissionBattleFacts\(finishCtx, settlementTime\)/)
        assert.match(source, /\.\.\.playerValues/)
        assert.match(responseSource, /"reward_pool_exp":\s*fixedPoolExpReward/)
    })
}
