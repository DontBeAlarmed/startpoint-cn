require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    getCommonScoreRewardCount,
    selectCommonScoreRewards,
    selectRareScoreRewards,
} = require("../src/lib/score-reward-lottery")

assert.equal(getCommonScoreRewardCount({ commonRewardCounts: [1, 2, 3, 4, 5] }, 4), 4)
assert.equal(getCommonScoreRewardCount({ commonRewardCount: 6 }, null), 6)
assert.equal(getCommonScoreRewardCount({ commonRewardCount: 6 }, null, 1.5), 9)
assert.equal(getCommonScoreRewardCount({}, 5), null)

const common = [
    { position: 1, type: 0, id: 10, count: 1, field5: 10 },
    { position: 2, type: 0, id: 20, count: 1, field5: 30 },
    { position: 3, type: 0, id: 30, count: 1, field5: 60 },
]

function sequence(values) {
    let index = 0
    return () => {
        assert.ok(index < values.length, "random sequence exhausted")
        return values[index++]
    }
}

assert.deepEqual(
    selectCommonScoreRewards(common, 4, sequence([0, 0.599999, 0.6, 0.9])),
    [common[2], common[2], common[1], common[0]],
)

const rarePools = [
    { position: 1, type: 1, id: 3013, rarity: 0.5 },
    { position: 2, type: 1, id: 3014, rarity: 0.2 },
]
const rareGroups = {
    3013: [
        { position: 1, type: 2, id: 443001, rarity: 0.3 },
        { position: 2, type: 2, id: 443002, rarity: 0.7 },
    ],
    3014: [
        { position: 1, type: 2, id: 443003, rarity: 0.5 },
        { position: 2, type: 2, id: 443004, rarity: 0.5 },
    ],
}

assert.deepEqual(
    selectRareScoreRewards(
        rarePools,
        groupId => rareGroups[groupId] ?? null,
        sequence([0.499999, 0.699999, 0.2]),
    ),
    [{ groupId: 3013, index: 2, reward: rareGroups[3013][1] }],
)

assert.deepEqual(
    selectRareScoreRewards(
        [rarePools[0]],
        groupId => rareGroups[groupId] ?? null,
        sequence([0, 0.7]),
    ),
    [{ groupId: 3013, index: 1, reward: rareGroups[3013][0] }],
)

assert.throws(
    () => selectCommonScoreRewards(common, 1, () => 1),
    /random value/i,
)

console.log("score reward lottery tests passed")
