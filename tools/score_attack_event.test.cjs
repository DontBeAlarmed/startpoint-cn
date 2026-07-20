const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const ROOT = path.resolve(__dirname, "..")

const {
    buildScoreAttackMainCharacterIds,
    calculateScoreAttackClearRank,
    handleScoreAttackEventFinish,
    resolveScoreAttackBorderTiers,
    selectScoreAttackRewardTiers,
} = require("../src/lib/quest/finish/score-attack-handler")
const { calculateClearRank } = require("../src/lib/quest/finish/quest-calc")

const thresholds = {
    bRankScore: 100,
    aRankScore: 200,
    sRankScore: 300,
    ssRankScore: 400,
}
assert.equal(calculateScoreAttackClearRank(99, thresholds), 1)
assert.equal(calculateScoreAttackClearRank(100, thresholds), 2)
assert.equal(calculateScoreAttackClearRank(199, thresholds), 2)
assert.equal(calculateScoreAttackClearRank(200, thresholds), 3)
assert.equal(calculateScoreAttackClearRank(300, thresholds), 4)
assert.equal(calculateScoreAttackClearRank(400, thresholds), 5)
assert.equal(calculateScoreAttackClearRank(9_000_000_000, thresholds), 5)

const tiers = [
    { id: 101001, eventId: 1, questId: 101, score: 100, reasonId: 16001, rewards: [{ kind: 0, id: 40501, amount: 1 }] },
    { id: 101002, eventId: 1, questId: 101, score: 200, reasonId: 16001, rewards: [{ kind: 0, id: 40502, amount: 2 }] },
    { id: 101003, eventId: 1, questId: 101, score: 300, reasonId: 16001, rewards: [{ kind: 0, id: 40503, amount: 3 }] },
]
assert.equal(resolveScoreAttackBorderTiers(1, 101, { "1_101": tiers }), tiers)
assert.throws(() => resolveScoreAttackBorderTiers(undefined, 101, { "1_101": tiers }), /event id/)
assert.throws(() => resolveScoreAttackBorderTiers(1, undefined, { "1_101": tiers }), /local quest id/)
assert.throws(() => resolveScoreAttackBorderTiers(1, 999, { "1_101": tiers }), /border tiers/)
assert.throws(() => resolveScoreAttackBorderTiers(1, 101, { "1_101": [] }), /border tiers/)
assert.deepEqual(selectScoreAttackRewardTiers(tiers, 0, 300).map(value => value.id), [101001, 101002, 101003])
assert.deepEqual(selectScoreAttackRewardTiers(tiers, 200, 300).map(value => value.id), [101003])
assert.deepEqual(selectScoreAttackRewardTiers(tiers, 300, 300), [])
assert.deepEqual(selectScoreAttackRewardTiers(tiers, 300, 200), [])

assert.deepEqual(buildScoreAttackMainCharacterIds({
    characters: [{ id: 101 }, null, { id: 103 }],
}), { 0: 101, 2: 103 })

function emptyGrantResult() {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

const calls = []
let capturedRewards = []
let storedProgress = null
const multiRewardTier = {
    id: 101075,
    eventId: 1,
    questId: 101,
    score: 300,
    reasonId: 16001,
    rewards: [
        { kind: 0, id: 40501, amount: 2 },
        { kind: 0, id: 40502, amount: 3 },
    ],
}
const result = handleScoreAttackEventFinish({
    playerId: 17,
    questId: 1101,
    category: 27,
    score: 300,
    elapsedTimeMs: 120000,
    isAccomplished: true,
    quest: thresholds,
    tiers: [tiers[0], tiers[1], multiRewardTier],
    party: { characters: [{ id: 101 }, { id: 102 }, null] },
}, {
    transaction(operation) {
        calls.push("begin")
        const value = operation()
        calls.push("commit")
        return value
    },
    getProgress() {
        calls.push("get-progress")
        return { questId: 1101, finished: true, highScore: 50, clearRank: 1, bestElapsedTimeMs: 130000 }
    },
    grantRewards(_playerId, rewards) {
        calls.push("grant")
        capturedRewards = rewards
        const inventory = { 40501: 7, 40502: 20 }
        for (const reward of rewards) inventory[reward.id] += reward.count
        return {
            user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
            character_list: [],
            joined_character_id_list: [],
            equipment_list: [],
            items: inventory,
        }
    },
    updateProgress(_playerId, category, progress) {
        calls.push(`progress:${category}`)
        storedProgress = progress
    },
    insertProgress() {
        assert.fail("已有进度不应插入新行")
    },
    deleteActiveQuest() {
        calls.push("delete-active")
    },
})

assert.deepEqual(calls, [
    "begin",
    "get-progress",
    "grant",
    "progress:27",
    "delete-active",
    "commit",
])
assert.deepEqual(result.scoreAttackEvent, {
    main_character_ids: { 0: 101, 1: 102 },
    reward_ids: [101001, 101002, 101075],
})
assert.deepEqual(result.rewardResult.user_info, { free_mana: 0, free_vmoney: 0, exp_pool: 0 })
assert.deepEqual(result.rewardResult.character_list, [])
assert.deepEqual(result.rewardResult.equipment_list, [])
assert.deepEqual(result.rewardResult.items, { 40501: 10, 40502: 25 })
assert.equal(result.oldHighScore, 50)
assert.equal(result.clearRank, 4)
assert.deepEqual(storedProgress, {
    questId: 1101,
    finished: true,
    highScore: 300,
    clearRank: 4,
    bestElapsedTimeMs: 120000,
    leaderCharacterId: 101,
})
assert.deepEqual(capturedRewards, [
    { type: 0, id: 40501, count: 3 },
    { type: 0, id: 40502, count: 5 },
])

for (const lowerScore of [300, 299]) {
    let grantCount = 0
    const repeated = handleScoreAttackEventFinish({
        playerId: 17,
        questId: 1101,
        category: 27,
        score: lowerScore,
        elapsedTimeMs: 110000,
        isAccomplished: true,
        quest: thresholds,
        tiers,
        party: { characters: [{ id: 101 }] },
    }, {
        transaction: operation => operation(),
        getProgress: () => ({ questId: 1101, finished: true, highScore: 300, clearRank: 4, bestElapsedTimeMs: 120000 }),
        grantRewards: () => { grantCount++; return emptyGrantResult() },
        updateProgress: () => {},
        insertProgress: () => assert.fail("已有进度不应插入新行"),
        deleteActiveQuest: () => {},
    })
    assert.equal(grantCount, 0)
    assert.deepEqual(repeated.scoreAttackEvent.reward_ids, [])
    assert.equal(repeated.oldHighScore, 300)
}

let insertedProgress = null
handleScoreAttackEventFinish({
    playerId: 18,
    questId: 1102,
    category: 27,
    score: 100,
    elapsedTimeMs: 90000,
    isAccomplished: true,
    quest: thresholds,
    tiers: [tiers[0]],
    party: { characters: [{ id: 201 }] },
}, {
    transaction: operation => operation(),
    getProgress: () => null,
    grantRewards: () => emptyGrantResult(),
    updateProgress: () => assert.fail("首次通关应插入进度"),
    insertProgress: (_playerId, category, progress) => { insertedProgress = { category, ...progress } },
    deleteActiveQuest: () => {},
})
assert.equal(insertedProgress.category, 27)
assert.equal(insertedProgress.highScore, 100)
assert.equal(insertedProgress.clearRank, 2)
assert.equal(insertedProgress.finished, true)

let deletedAfterFailure = false
assert.throws(() => handleScoreAttackEventFinish({
    playerId: 19,
    questId: 1103,
    category: 27,
    score: 100,
    elapsedTimeMs: 90000,
    isAccomplished: true,
    quest: thresholds,
    tiers: [tiers[0]],
    party: { characters: [{ id: 301 }] },
}, {
    transaction: operation => operation(),
    getProgress: () => null,
    grantRewards: () => { throw new Error("grant failed") },
    updateProgress: () => {},
    insertProgress: () => {},
    deleteActiveQuest: () => { deletedAfterFailure = true },
}), /grant failed/)
assert.equal(deletedAfterFailure, false)

assert.throws(() => handleScoreAttackEventFinish({
    playerId: 20,
    questId: 1104,
    category: 27,
    score: 100,
    elapsedTimeMs: 90000,
    isAccomplished: true,
    quest: thresholds,
    tiers: [{
        id: 104001,
        eventId: 1,
        questId: 104,
        score: 100,
        reasonId: 16001,
        rewards: [{ kind: 1, id: 505001, amount: 1 }],
    }],
    party: { characters: [{ id: 401 }] },
}, {
    transaction: operation => operation(),
    getProgress: () => null,
    grantRewards: () => emptyGrantResult(),
    updateProgress: () => {},
    insertProgress: () => {},
    deleteActiveQuest: () => {},
}), /unsupported reward kind 1/)

assert.equal(calculateClearRank(999, {
    bRankTime: 1000,
    aRankTime: 800,
    sRankTime: 600,
    sPlusRankTime: 400,
}), 2)

const finishSource = fs.readFileSync(
    path.join(ROOT, "src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
assert.match(finishSource, /"score_attack_event"\s*:\s*scoreAttackEventData/)
assert.match(finishSource, /handleScoreAttackEventFinish\s*\(/)

console.log("score attack event tests passed")
