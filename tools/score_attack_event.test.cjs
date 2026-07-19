const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const ROOT = path.resolve(__dirname, "..")
const RAW_ROOT = path.resolve(ROOT, "..", "wf-assets-cn", "orderedmap")

const rawQuests = JSON.parse(fs.readFileSync(
    path.join(RAW_ROOT, "quest/event/score_attack_event_quest.json"),
    "utf8",
))
const rawBorderRewards = JSON.parse(fs.readFileSync(
    path.join(RAW_ROOT, "quest/event/score_attack_border_reward.json"),
    "utf8",
))
const quests = JSON.parse(fs.readFileSync(
    path.join(ROOT, "assets/score_attack_event_quest.json"),
    "utf8",
))
const borderRewards = JSON.parse(fs.readFileSync(
    path.join(ROOT, "assets/score_attack_border_reward.json"),
    "utf8",
))
const entryCosts = JSON.parse(fs.readFileSync(
    path.join(ROOT, "assets/quest_entry_costs.json"),
    "utf8",
))

function flattenQuestRows(source) {
    const rows = []
    for (const [eventId, folders] of Object.entries(source)) {
        for (const [localQuestId, values] of Object.entries(folders)) {
            for (const row of values) rows.push({
                eventId: Number(eventId),
                localQuestId: Number(localQuestId),
                row,
            })
        }
    }
    return rows
}

function optionalNumber(value) {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    return Number(value)
}

const rawQuestRows = flattenQuestRows(rawQuests)
assert.equal(rawQuestRows.length, 123)
assert.equal(Object.keys(quests).length, 123)

for (const { eventId, localQuestId, row } of rawQuestRows) {
    const questId = String(row[0])
    const converted = quests[questId]
    assert.ok(converted, `缺少无限演武关卡 ${questId}`)
    assert.equal(converted.eventId, eventId)
    assert.equal(converted.folderId, optionalNumber(row[1]))
    assert.equal(converted.scoreAttackQuestId, localQuestId)
    assert.equal(converted.name, row[4])
    assert.equal(converted.bRankScore, Number(row[52]))
    assert.equal(converted.aRankScore, Number(row[53]))
    assert.equal(converted.sRankScore, Number(row[54]))
    assert.equal(converted.ssRankScore, Number(row[55]))
    assert.equal(converted.rankPointReward, Number(row[86]))
    assert.equal(converted.characterExpReward, Number(row[87]))
    assert.equal(converted.manaReward, Number(row[88]))
    assert.equal(converted.poolExpReward, Number(row[89]))
    assert.equal(converted.timeLimitMs, Math.round(Number(row[104]) * 1000 / 60))
    assert.equal(converted.element, Number(row[73]))
    assert.equal(converted.clearRewardId, optionalNumber(row[6]))
    assert.equal(converted.scoreRewardGroupId, optionalNumber(row[72]))
    assert.equal(converted.sPlusRewardId, undefined)
    assert.deepEqual(entryCosts[`27_${questId}`], { itemId: 0, itemCount: 0, stamina: 10 })
    assert.equal(entryCosts[`9_${questId}`], undefined)
}

let convertedBorderCount = 0
for (const [rewardId, wrappers] of Object.entries(rawBorderRewards)) {
    const row = wrappers[0]
    const key = `${row[1]}_${row[2]}`
    const converted = borderRewards[key]?.find(value => value.id === Number(rewardId))
    assert.ok(converted, `缺少无限演武分数奖励行 ${rewardId}`)
    assert.equal(converted.eventId, Number(row[1]))
    assert.equal(converted.questId, Number(row[2]))
    assert.equal(converted.score, Number(row[4]))
    assert.equal(converted.reasonId, Number(row[5]))

    const expectedSlots = []
    for (let slot = 0; slot < 6; slot++) {
        const base = 6 + slot * 3
        const kind = optionalNumber(row[base])
        if (kind === undefined) continue
        const id = optionalNumber(row[base + 1])
        expectedSlots.push({
            kind,
            ...(id !== undefined ? { id } : {}),
            amount: Number(row[base + 2]),
        })
    }
    assert.deepEqual(converted.rewards, expectedSlots)
    convertedBorderCount++
}
assert.equal(convertedBorderCount, 11100)
assert.equal(borderRewards["1_101"].find(value => value.id === 101075).rewards.length, 2)

const {
    buildScoreAttackMainCharacterIds,
    calculateScoreAttackClearRank,
    handleScoreAttackEventFinish,
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
        { kind: 1, id: 505001, amount: 1 },
        { kind: 2, amount: 50 },
        { kind: 3, amount: 1000 },
        { kind: 4, amount: 2000 },
        { kind: 6, id: 101, amount: 1 },
        { kind: 7, id: 61000, amount: 1 },
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
        return {
            user_info: { free_mana: 1000, free_vmoney: 50, exp_pool: 2000 },
            character_list: [{ character_id: 101 }],
            joined_character_id_list: [101],
            equipment_list: [{ equipment_id: 505001 }],
            items: { 40501: 12, 40502: 3 },
        }
    },
    giveDegree(_playerId, degreeId) {
        calls.push(`degree:${degreeId}`)
        return true
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
    "degree:61000",
    "progress:27",
    "delete-active",
    "commit",
])
assert.deepEqual(result.scoreAttackEvent, {
    main_character_ids: { 0: 101, 1: 102 },
    reward_ids: [101001, 101002, 101075],
})
assert.deepEqual(result.rewardResult.user_info, { free_mana: 1000, free_vmoney: 50, exp_pool: 2000 })
assert.deepEqual(result.rewardResult.character_list, [{ character_id: 101 }])
assert.deepEqual(result.rewardResult.equipment_list, [{ equipment_id: 505001 }])
assert.deepEqual(result.rewardResult.items, { 40501: 12, 40502: 3 })
assert.deepEqual(result.newDegreeIds, [61000])
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
    { type: 0, id: 40502, count: 2 },
    { type: 1, id: 505001, count: 1 },
    { type: 3, count: 50 },
    { type: 4, count: 1000 },
    { type: 5, count: 2000 },
    { type: 2, id: 101 },
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
        giveDegree: () => false,
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
    giveDegree: () => false,
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
    giveDegree: () => false,
    updateProgress: () => {},
    insertProgress: () => {},
    deleteActiveQuest: () => { deletedAfterFailure = true },
}), /grant failed/)
assert.equal(deletedAfterFailure, false)

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
