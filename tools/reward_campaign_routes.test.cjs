const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

function routeSource(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8")
}

for (const [name, settlementPath, responsePath] of [
    ["单人", "src/lib/quest/finish/single-settlement-writes.ts", "src/routes/api/singleBattleQuest.ts"],
    ["联机", "src/multi/http/battle.ts", "src/multi/http/battle.ts"],
]) {
    test(`${name}结算复用同一服务器时间并接入奖励活动倍率`, () => {
        const source = routeSource(settlementPath)
        const responseSource = routeSource(responsePath)
        assert.match(source, /const settlementTime = new Date\(getServerTime\(\) \* 1000\)/)
        assert.match(
            source,
            /getRewardCampaignRates\(\s*questCategory,\s*questId,\s*settlementTime,?\s*\)/,
        )
        assert.match(
            source,
            /calculateFixedQuestMana\(\s*questData\.manaReward,\s*rewardCampaignRates,\s*useBoostPoint,?\s*\)/,
        )
        assert.match(
            source,
            /calculateFixedQuestPoolExp\(\s*questData\.poolExpReward,\s*rewardCampaignRates,\s*useBoostPoint,?\s*\)/,
        )
        assert.match(
            source,
            /calculateCharacterBattleExp\([\s\S]*?,\s*rewardCampaignRates,?\s*\)/,
        )
        assert.match(source, /rewardCampaignRates[,\n]/)
        assert.match(source, /rewardDate:\s*settlementTime/)
        assert.match(source, /recordMissionBattleFacts\(finishCtx, settlementTime\)/)
        assert.match(source, /expPool:\s*[^,\n]+\+\s*fixedPoolExpReward/)
        assert.match(responseSource, /"reward_pool_exp":\s*fixedPoolExpReward/)
    })
}
