require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    getRaidEventOverallRewardDefinitions,
    parseRaidEventOverallRewardDefinitions,
    selectRaidEventOverallRewards,
} = require("../src/lib/quest/finish/raid-overall-rewards")

const malformedRewardRow = Array(37).fill("")
malformedRewardRow[0] = "4"
malformedRewardRow[2] = "0"
malformedRewardRow[3] = "1"
malformedRewardRow[7] = "99"
malformedRewardRow[9] = "1"
assert.throws(
    () => parseRaidEventOverallRewardDefinitions({ 1: [malformedRewardRow] }),
    /unsupported reward kind/,
    "非空但未知的奖励槽必须拒绝整张表",
)

const event4 = getRaidEventOverallRewardDefinitions(4)
assert.equal(event4.length, 14, "战阵活动 4 应读取 14 条官方总击破奖励")
assert.deepEqual(event4.find(reward => reward.id === 24).requirement, { kind: "total", threshold: 50 })
assert.deepEqual(event4.find(reward => reward.id === 24).rewards, [
    { kind: "item", itemId: 49100, amount: 5 },
    { kind: "item", itemId: 10003, amount: 1 },
], "每行 10 个奖励槽都必须解析，不能只读取第一个槽")

const firstKill = selectRaidEventOverallRewards(event4, 0, 1)
assert.deepEqual(firstKill.map(reward => ({
    id: reward.id,
    kind: reward.kind,
    amount: reward.amount,
})), [
    { id: 23, kind: "mana", amount: 500 },
    { id: 23, kind: "item", amount: 25 },
])

const firstThresholds = selectRaidEventOverallRewards(event4, 1, 151)
assert.deepEqual(firstThresholds.map(reward => ({
    id: reward.id,
    kind: reward.kind,
    amount: reward.amount,
})), [
    { id: 24, kind: "item", amount: 5 },
    { id: 24, kind: "item", amount: 1 },
    { id: 25, kind: "item", amount: 10 },
    { id: 25, kind: "item", amount: 1 },
    { id: 26, kind: "item", amount: 10 },
    { id: 26, kind: "item", amount: 1 },
    { id: 23, kind: "mana", amount: 75000 },
    { id: 23, kind: "item", amount: 3750 },
])

assert.deepEqual(
    selectRaidEventOverallRewards(event4, 5, 5),
    [],
    "重复结算且没有新增击破数不得重复生成事件奖励",
)

console.log("raid event overall reward tests passed")
