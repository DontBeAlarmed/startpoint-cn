require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    getRaidEventOverallRewardDefinitions,
    selectRaidEventOverallRewards,
} = require("../src/lib/quest/finish/raid-overall-rewards")

const event4 = getRaidEventOverallRewardDefinitions(4)
assert.equal(event4.length, 14, "战阵活动 4 应读取 14 条官方总击破奖励")
assert.deepEqual(event4.find(reward => reward.id === 24).requirement, { kind: "total", threshold: 50 })

const firstKill = selectRaidEventOverallRewards(event4, 0, 1, 1)
assert.deepEqual(firstKill.map(reward => ({
    id: reward.id,
    kind: reward.kind,
    amount: reward.amount,
})), [
    { id: 23, kind: "mana", amount: 500 },
])

const firstThresholds = selectRaidEventOverallRewards(event4, 1, 151, 150)
assert.deepEqual(firstThresholds.map(reward => ({
    id: reward.id,
    kind: reward.kind,
    amount: reward.amount,
})), [
    { id: 24, kind: "item", amount: 5 },
    { id: 25, kind: "item", amount: 10 },
    { id: 26, kind: "item", amount: 10 },
    { id: 23, kind: "mana", amount: 75000 },
])

assert.deepEqual(
    selectRaidEventOverallRewards(event4, 5, 5, 0),
    [],
    "重复结算且没有新增击破数不得重复生成事件奖励",
)

console.log("raid event overall reward tests passed")
