require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({ additionalTableNames: ["raid_event_overall_reward.json"] })
process.once("exit", () => { restoreContentSnapshot() })


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
        return {
            rewardResult: {
                user_info: { free_mana: 500, free_vmoney: 0, exp_pool: 0 },
                character_list: [],
                joined_character_id_list: [],
                equipment_list: [],
                items: { 100000: 25 },
            },
            invalidatedFactKeys: [{ kind: "player" }],
        }
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
assert.deepEqual(first.rewardResult.items, { 100000: 25 })
assert.deepEqual(first.invalidatedFactKeys, [{ kind: "player" }])

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
assert.deepEqual(repeated.invalidatedFactKeys, [])

console.log("raid event summary tests passed")
