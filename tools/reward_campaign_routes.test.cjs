const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

function routeSource(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8")
}

for (const [name, relativePath] of [
    ["单人", "src/routes/api/singleBattleQuest.ts"],
    ["联机", "src/multi/http/battle.ts"],
]) {
    test(`${name}结算复用同一服务器时间并接入奖励活动倍率`, () => {
        const source = routeSource(relativePath)
        assert.match(source, /const settlementTime = new Date\(getServerTime\(\) \* 1000\)/)
        assert.match(
            source,
            /getRewardCampaignRates\(\s*questCategory,\s*questId,\s*settlementTime,?\s*\)/,
        )
        assert.match(
            source,
            /calculateFixedQuestMana\(\s*questData\.manaReward,\s*rewardCampaignRates,?\s*\)/,
        )
        assert.match(
            source,
            /calculateCharacterBattleExp\([\s\S]*?,\s*rewardCampaignRates,?\s*\)/,
        )
        assert.match(source, /rewardCampaignRates[,\n]/)
        assert.match(source, /rewardDate:\s*settlementTime/)
        assert.match(source, /recordMissionBattleFacts\(finishCtx, settlementTime\)/)
    })
}
