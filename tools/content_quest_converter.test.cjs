"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    buildDailyChallengePointLookup,
    buildEventChallengePointMap,
    buildQuestEntryCosts,
    buildQuestLookup,
    buildQuestUnlockCosts,
    convertQuestTree,
    QUEST_AUXILIARY_SOURCES,
    QUEST_TABLE_SOURCES,
} = require("../src/content/converters/quest")

function row(length, values) {
    const output = Array.from({ length }, () => "")
    for (const [index, value] of Object.entries(values)) output[Number(index)] = String(value)
    return output
}

test("quest converter closes the 20 authoritative quest tables", () => {
    assert.equal(Object.keys(QUEST_TABLE_SOURCES).length, 20)
    assert.deepEqual(QUEST_TABLE_SOURCES["main_quest.json"], {
        logicalPath: "master/quest/main_quest.orderedmap",
        nestingDepth: 3,
    })
    assert.deepEqual(QUEST_TABLE_SOURCES["character_quest.json"], {
        logicalPath: "master/quest/character_quest.orderedmap",
        nestingDepth: 1,
    })
    assert.equal("practice_quest.json" in QUEST_TABLE_SOURCES, false)
})

test("standard quest conversion separates story rows from battle rows", () => {
    const story = row(119, { 0: 1001001, 1: "剧情", 3: 1, 84: "(None)" })
    const battle = row(119, {
        0: 1001002,
        1: "战斗",
        3: 2,
        70: 300,
        71: 3,
        72: 4,
        84: 12.5,
        85: 10,
        86: 8.5,
        87: 7,
        88: 1,
        89: 2,
        90: 3,
        91: 4,
        92: 5,
        93: 20,
        94: 30,
        95: 40,
        96: 50,
        118: 9,
    })
    const output = convertQuestTree("main_quest.json", {
        1: { 1: { 1: [story], 2: [battle] } },
    })

    assert.deepEqual(output, {
        1001001: { name: "剧情", clearRewardId: 1 },
        1001002: {
            name: "战斗",
            clearRewardId: 2,
            scoreRewardGroupId: 300,
            bRankTime: 12500,
            aRankTime: 10000,
            sRankTime: 8500,
            sPlusRankTime: 7000,
            commonRewardCounts: [1, 2, 3, 4, 5],
            rankPointReward: 20,
            characterExpReward: 30,
            manaReward: 40,
            poolExpReward: 50,
            element: 4,
            fixedParty: 9,
            sPlusRewardId: 3,
        },
    })
})

test("authoritative reward and common-drop count columns are preserved", () => {
    const advent = row(103, {
        0: 200013009,
        2: "降临",
        4: 10,
        75: 30,
        76: 20,
        77: 11,
        78: 5,
        90: 30,
        91: 20,
        92: 10,
        93: 5,
        94: 1,
        95: 2,
        96: 3,
        97: 4,
        98: 5,
        99: 101,
        100: 102,
        101: 103,
        102: 104,
    })
    assert.deepEqual(convertQuestTree("advent_event_quest.json", {
        1: { 1: [advent] },
    })[200013009], {
        name: "降临",
        clearRewardId: 10,
        scoreRewardGroupId: 20,
        bRankTime: 30000,
        aRankTime: 20000,
        sRankTime: 10000,
        sPlusRankTime: 5000,
        commonRewardCounts: [1, 2, 3, 4, 5],
        rankPointReward: 101,
        characterExpReward: 102,
        manaReward: 103,
        poolExpReward: 104,
        element: 5,
        sPlusRewardId: 11,
    })

    const challenge = row(98, {
        0: 1038,
        2: "宝物域",
        4: 12,
        70: 0,
        71: 30,
        72: 13,
        73: 4,
        85: 40,
        86: 30,
        87: 20,
        88: 10,
        89: 1,
        90: 2,
        91: 3,
        92: 4,
        93: 5,
        94: 201,
        95: 202,
        96: 203,
        97: 204,
    })
    assert.deepEqual(convertQuestTree("challenge_dungeon_event_quest.json", {
        1: { 1: [challenge] },
    })[1038], {
        name: "宝物域",
        clearRewardId: 12,
        scoreRewardGroupId: 30,
        bRankTime: 40000,
        aRankTime: 30000,
        sRankTime: 20000,
        sPlusRankTime: 10000,
        commonRewardCounts: [1, 2, 3, 4, 5],
        rankPointReward: 201,
        characterExpReward: 202,
        manaReward: 203,
        poolExpReward: 204,
        element: 4,
        sPlusRewardId: 13,
    })
})

test("hard multi conversion preserves first-clear and S+ reward ids", () => {
    const quest = row(98, {
        0: 100002001,
        2: "决战级",
        4: 200077004,
        72: 200077005,
        73: 2,
        85: 300,
        86: 240,
        87: 180,
        88: 120,
        94: 100,
        95: 200,
        96: 300,
        97: 400,
    })
    assert.deepEqual(convertQuestTree("hard_multi_event_quest.json", {
        100002: { 1: [quest] },
    }), {
        100002001: {
            name: "决战级",
            clearRewardId: 200077004,
            sPlusRewardId: 200077005,
            bRankTime: 300000,
            aRankTime: 240000,
            sRankTime: 180000,
            sPlusRankTime: 120000,
            rankPointReward: 100,
            characterExpReward: 200,
            manaReward: 300,
            poolExpReward: 400,
            element: 2,
        },
    })
})

test("score attack and carnival conversions preserve event-local metadata", () => {
    const scoreAttack = row(105, {
        0: 1101,
        1: 2,
        4: "评分战",
        6: 11,
        52: 1000,
        53: 2000,
        54: 3000,
        55: 4000,
        72: 500,
        73: 3,
        85: 6,
        86: 10,
        87: 20,
        88: 30,
        89: 40,
        104: 5400,
    })
    assert.deepEqual(convertQuestTree("score_attack_event_quest.json", {
        7: { 3: [scoreAttack] },
    }), {
        1101: {
            name: "评分战",
            eventId: 7,
            scoreAttackQuestId: 3,
            bRankScore: 1000,
            aRankScore: 2000,
            sRankScore: 3000,
            ssRankScore: 4000,
            rankPointReward: 10,
            characterExpReward: 20,
            manaReward: 30,
            poolExpReward: 40,
            element: 3,
            timeLimitMs: 90000,
            folderId: 2,
            clearRewardId: 11,
            scoreRewardGroupId: 500,
            commonRewardCount: 6,
        },
    })

    const carnival = row(105, {
        0: 2201,
        1: 4,
        6: 12,
        69: 2,
        82: 5,
        83: 6,
        84: 7,
        85: 8,
        100: 3600,
        104: 999,
    })
    assert.deepEqual(convertQuestTree("carnival_event_quest.json", {
        22: { 1: [carnival] },
    }), {
        2201: {
            name: "",
            clearRewardId: 12,
            bRankTime: 0,
            aRankTime: 0,
            sRankTime: 0,
            sPlusRankTime: 0,
            rankPointReward: 5,
            characterExpReward: 6,
            manaReward: 7,
            poolExpReward: 8,
            element: 2,
            eventId: 22,
            folderId: 4,
            timeLimitMs: 60000,
            difficultyScore: 999,
        },
    })
})

test("character quest uses the OrderedMap key and rejects malformed rows", () => {
    const character = row(6, { 3: "角色剧情", 5: 17 })
    assert.deepEqual(convertQuestTree("character_quest.json", {
        101: [character],
    }), {
        101: { name: "角色剧情", clearRewardId: 17 },
    })
    assert.throws(
        () => convertQuestTree("character_quest.json", { 101: [["broken"]] }),
        /invalid quest content.*character_quest\.json/i,
    )
})

test("quest derived tables use authoritative categories, costs and names", () => {
    const main = row(119, { 0: 1001, 1: "主线", 3: 1, 55: "(None)", 69: 6, 84: 30 })
    const ranking = row(80, { 0: 2001, 2: "竞速", 4: 2, 52: "(None)", 66: 9, 68: 0 })
    const hard = row(98, { 0: 3001, 2: "歼灭者", 4: 3, 56: "(None)", 69: 999, 70: 5, 73: 1 })
    const adventTicket = row(103, {
        0: 4001,
        2: "门票降临",
        4: 4,
        61: 1,
        62: 40314,
        63: 2,
        75: 0,
        78: 2,
        90: 10,
    })
    const worldUnlock = row(120, {
        0: 5001,
        2: "一次解锁",
        4: 5,
        56: 0,
        57: "60001,60002",
        58: "1,2",
        70: 16,
        73: 3,
        85: 10,
    })
    const trees = {
        "main_quest.json": { 1: { 1: { 1: [main] } } },
        "ranking_event_single_quest.json": { 1: { 1: [ranking] } },
        "hard_multi_event_quest.json": { 1: { 1: [hard] } },
        "advent_event_quest.json": { 1: { 1: [adventTicket] } },
        "world_story_event_quest.json": { 1: { 1: [worldUnlock] } },
    }

    assert.deepEqual(buildQuestEntryCosts(trees), {
        "1_1001": { itemId: 0, itemCount: 0, stamina: 6 },
        "7_4001": { itemId: 40314, itemCount: 2, stamina: 0 },
        "11_2001": { itemId: 0, itemCount: 0, stamina: 9 },
        "18_5001": { itemId: 0, itemCount: 0, stamina: 16 },
        "26_3001": { itemId: 0, itemCount: 0, stamina: 5 },
    })
    assert.deepEqual(buildQuestUnlockCosts(trees), {
        5001: { itemIds: [60001, 60002], itemCounts: [1, 2] },
    })

    const converted = Object.fromEntries(Object.entries(trees).map(([tableName, tree]) => (
        [tableName, convertQuestTree(tableName, tree)]
    )))
    assert.deepEqual(converted["ranking_event_single_quest.json"][2001], {
        name: "竞速",
        clearRewardId: 2,
        bRankTime: 0,
        aRankTime: 0,
        sRankTime: 0,
        sPlusRankTime: 0,
        rankPointReward: 0,
        characterExpReward: 0,
        manaReward: 0,
        poolExpReward: 0,
        element: 0,
    })
    assert.deepEqual(buildQuestLookup(
        converted,
        { 91: [["92", "4", "练习场"]] },
        {
            80: { name: "" },
            91: { name: "旧名称不会覆盖官方名称" },
            fixture: { name: "测试夹具不能成为关卡" },
            92: {},
        },
    ), {
        "1_1001": "主线",
        "7_4001": "门票降临",
        "11_2001": "竞速",
        "15_91": "练习场",
        "15_80": "",
        "18_5001": "一次解锁",
        "26_3001": "歼灭者",
    })
})

test("challenge point derivatives come from their authoritative master rows", () => {
    assert.deepEqual(QUEST_AUXILIARY_SOURCES, {
        dailyChallengePoint: "master/quest/event/daily_challenge_point.orderedmap",
        expertSingleEvent: "master/quest/event/expert_single_event.orderedmap",
        soloTimeAttackEvent: "master/quest/event/solo_time_attack_event.orderedmap",
        practiceQuest: "master/quest/practice/practice_quest.orderedmap",
    })
    assert.deepEqual(buildDailyChallengePointLookup({
        1: [["expert", "9999", "999", "true", "挑战次数"]],
        2: [["event", "1", "1", "false", "活动次数"]],
    }), {
        1: { maxPoint: 9999, isRecovery: true, name: "挑战次数" },
        2: { maxPoint: 1, isRecovery: false, name: "活动次数" },
    })
    assert.deepEqual(buildEventChallengePointMap(
        { 1: [["expert", "name", "", "", "", "", "", "", "", "", "1"]], 2: [["expert2", "name", "", "", "", "", "", "", "", "", "251"]] },
        { 1: [["solo", "name", "", "", "", "", "", "", "", "5001"]] },
    ), {
        expert_1: 1,
        expert_2: 251,
        solo_1: 5001,
    })
})
