require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { getRaidEventOverallRewardDefinitions } = require("../src/lib/quest/finish/raid-overall-rewards")
const { settleRaidEventSummary } = require("../src/lib/raid-event-summary")

const definitions = getRaidEventOverallRewardDefinitions(4)
const given = []
let cursor = 0

const first = settleRaidEventSummary({
    playerId: 7,
    totalKillCount: 1,
    receivedUpTo: cursor,
    definitions,
    giveRewards: (_playerId, rewards) => {
        given.push(rewards)
        return { user_info: { free_mana: 500, free_vmoney: 0, exp_pool: 0 } }
    },
    updateReceivedUpTo: value => { cursor = value },
})
assert.equal(cursor, 1)
assert.deepEqual(first.grants.map(grant => [grant.kind, grant.itemId, grant.amount]), [
    ["mana", undefined, 500],
    ["item", 100000, 25],
])
assert.equal(given.length, 1)
assert.equal(given[0].length, 2, "同一 summary 的奖励应先聚合后统一发放")

const repeated = settleRaidEventSummary({
    playerId: 7,
    totalKillCount: 1,
    receivedUpTo: cursor,
    definitions,
    giveRewards: () => assert.fail("重复 summary 不得再次发奖"),
    updateReceivedUpTo: value => { cursor = value },
})
assert.deepEqual(repeated.grants, [])
assert.equal(cursor, 1)

console.log("raid event summary tests passed")
