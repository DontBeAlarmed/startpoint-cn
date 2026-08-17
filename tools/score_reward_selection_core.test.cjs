"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const corePath = path.join(
    __dirname,
    "../src/lib/quest/score-reward-selection-core.ts",
)

function sequence(values, calls) {
    let index = 0
    return () => {
        assert.ok(index < values.length, "random sequence exhausted")
        const value = values[index++]
        calls.push(value)
        return value
    }
}

test("core selects normalized common and Rare grants from explicit dependencies only", () => {
    const { selectScoreRewardGrantPlanCore } = require(corePath)
    const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")
    const randomCalls = []
    const dependencyCalls = []
    const selection = selectScoreRewardGrantPlanCore({
        groupId: 8801,
        scoreRewards: [
            {
                position: 3,
                name: "common",
                type: ScoreRewardType.ITEM,
                reward_type: RewardType.ITEM,
                id: 400001,
                count: 2,
                field5: 1,
            },
            { position: 5, name: "rare", type: ScoreRewardType.RARE_POOL, id: 9901, rarity: 1 },
        ],
        boostPointUsed: true,
        questElement: 4,
        commonRewardCount: 1,
        random: sequence([0, 0, 0], randomCalls),
        rewardCampaignRates: { item: 1.5, exp: 1, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
        dropMultiplier: 2,
    }, {
        getRareScoreRewardGroup(groupId) {
            dependencyCalls.push(["rare", groupId])
            return [{ position: 7, name: "aether", type: RewardType.AETHER, id: 4, count: 3, rarity: 1 }]
        },
        resolveEventCurrencyId(itemId, rewardDate) {
            dependencyCalls.push(["event", itemId, rewardDate.toISOString()])
            return itemId + 100000
        },
        resolveContextualItemId(kind, rarity, questElement) {
            dependencyCalls.push(["context", kind, rarity, questElement])
            return kind === "aether" ? 600004 : 500004
        },
    })

    assert.deepEqual(randomCalls, [0, 0, 0])
    assert.deepEqual(dependencyCalls, [
        ["event", 400001, "2024-08-14T12:00:00.000Z"],
        ["rare", 9901],
        ["context", "aether", 4, 4],
    ])
    assert.deepEqual(selection.plan.entries, [
        {
            source: { kind: "score_common", groupId: 8801, index: 3, number: 10 },
            reward: { name: "common", type: RewardType.ITEM, id: 500001, count: 10 },
        },
        {
            source: { kind: "score_rare", groupId: 9901, index: 7, number: 14 },
            reward: { name: "aether", type: RewardType.AETHER, id: 600004, count: 14 },
        },
    ])
})

test("core source has no runtime content, server settings, time or event currency imports", () => {
    const source = fs.readFileSync(corePath, "utf8")

    assert.doesNotMatch(source, /content\/runtime|server-settings|\.\.\/\.\.\/utils/)
    assert.doesNotMatch(source, /from ["'][^"']*(?:assets|event-currency)["']/)
    assert.doesNotMatch(source, /getServerTime|getRuntimeContentTableSync|getServerGameplaySettingsSync/)
})

test("core rejects Rare reward probability above one or group totals above one", () => {
    const { selectScoreRewardGrantPlanCore, ScoreRewardNormalizationError } = require(corePath)
    const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")
    const pool = [{ position: 1, type: ScoreRewardType.RARE_POOL, id: 9902, rarity: 1 }]
    const input = overrides => ({
        groupId: 8802,
        scoreRewards: pool,
        boostPointUsed: false,
        commonRewardCount: 0,
        random: sequence([0, 0], []),
        rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
        dropMultiplier: 1,
        ...overrides,
    })
    const dependencies = group => ({
        getRareScoreRewardGroup: () => group,
        resolveEventCurrencyId: itemId => itemId,
        resolveContextualItemId: () => 1,
    })
    const reward = (position, rarity) => ({
        position,
        type: RewardType.MANA,
        count: 1,
        rarity,
    })

    assert.throws(
        () => selectScoreRewardGrantPlanCore(input({}), dependencies([reward(1, 2)])),
        error => error instanceof ScoreRewardNormalizationError
            && error.groupId === 9902
            && error.index === 1
            && error.field === "rarity",
    )
    assert.throws(
        () => selectScoreRewardGrantPlanCore(
            input({}),
            dependencies([reward(1, 0.6), reward(2, 0.5)]),
        ),
        error => error instanceof ScoreRewardNormalizationError
            && error.groupId === 9902
            && error.field === "rarity",
    )
})

test("core accepts valid Rare groups whose probability total is below or equal to one", () => {
    const { selectScoreRewardGrantPlanCore } = require(corePath)
    const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")
    const reward = (position, rarity) => ({
        position,
        type: RewardType.MANA,
        count: 1,
        rarity,
    })
    const dependencies = group => ({
        getRareScoreRewardGroup: () => group,
        resolveEventCurrencyId: itemId => itemId,
        resolveContextualItemId: () => 1,
    })
    const base = (random, group) => selectScoreRewardGrantPlanCore({
        groupId: 8803,
        scoreRewards: [{ position: 1, type: ScoreRewardType.RARE_POOL, id: 9903, rarity: 1 }],
        boostPointUsed: false,
        commonRewardCount: 0,
        random: sequence(random, []),
        rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
        dropMultiplier: 1,
    }, dependencies(group))

    assert.equal(base([0, 0], [reward(1, 0.4), reward(2, 0.6)]).plan.entries.length, 1)
    assert.equal(base([0, 0.2], [reward(1, 0.4), reward(2, 0.2)]).plan.entries.length, 1)
})
