"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    EMPTY_BATTLE_COUNTERS,
    allFacts,
    bundledMissionContentRepository,
    character,
    clone,
    createSession,
    getMissionCatalog,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

test("Degree Session derives selectors and state from every supplied custom Catalog table", () => {
    const definitions = clone(bundledMissionContentRepository.table("mission_degree.json"))
    const rewards = clone(bundledMissionContentRepository.table("mission_degree_reward.json"))
    definitions[111001][0][15] = "999001"
    definitions[1111001][0][15] = "999001"
    definitions[9000][0][9] = "9"
    definitions[12000][0][11] = "901,902"
    definitions[11010][0][9] = "9"
    definitions[11010][0][10] = "8"
    definitions[11010][0][12] = "4"
    for (const [missionId, eventId, suffix] of [
        [57010, 777, 3], [58000, 888, 4], [68000, 999, 5],
        [61040, 666, 6], [62330, 555, 7],
    ]) {
        definitions[missionId][0][9] = String(eventId)
        definitions[missionId][0][11] = String(suffix)
    }
    definitions[70000][0][13] = "79999"
    definitions[14000][0][2] = "单人战斗获得12345以上的分数"
    const catalog = getMissionCatalog(repositoryWith({
        "mission_degree.json": definitions,
        "mission_degree_reward.json": rewards,
        "config.json": { craft_point_item_id: 78888 },
        "character.json": { 999001: { rarity: 5 } },
        "mana_board.json": { 999001: { 2: { a: [[101]], b: [[102]] } } },
        "main_quest.json": { 9000001: {} },
        "ex_quest.json": { 9000002: {} },
        "treasure_shop.json": { 555: {} },
        "boss_battle_quest.json": { 9008001: { enemyLevel: 80 } },
        "expert_single_event_quest.json": { 777003: {} },
        "world_story_event_quest.json": { 888004: {} },
        "advent_event_quest.json": { 999005: {} },
        "carnival_event_quest.json": { 666006: {} },
        "hard_multi_event_quest.json": { 555007: {} },
        "equipment_dissolve.json": { 777: { max_level: 3 } },
    }, "all-custom-degree-tables"))
    const missionIds = [3010, 111001, 1111001, 9000, 12000, 46000, 11010, 57010,
        58000, 68000, 61040, 62330, 41000, 70000, 43000, 14000]
    const facts = allFacts({
        characters: {
            999001: character({
                exp: 379988,
                bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
            }),
        },
        characterManaNodes: { 999001: [101, 102] },
        questProgress: {
            1: [{ questId: 9000001, finished: true }],
            2: [{ questId: 9008001, finished: true }],
            4: [{ questId: 9000002, finished: true }],
            7: [{ questId: 999005, finished: true }],
            15: [{ questId: 901, finished: true, clearRank: 5 }, { questId: 902, finished: true, clearRank: 5 }],
            18: [{ questId: 888004, finished: true }],
            21: [{ questId: 777003, finished: true }],
            22: [{ questId: 666006, finished: true }],
            26: [{ questId: 555007, finished: true }],
        },
        shopPurchases: { 555: 4, 556: 100 },
        collectedItems: { 78888: 8, 79999: 7 },
        equipment: { 777: { level: 3, enhancementLevel: 0, protection: false, stack: 0 } },
        missionBattleCounters: { ...EMPTY_BATTLE_COUNTERS, singleScoreMax: 20000 },
    })
    const context = DegreeComputer.buildContextFromSession(
        createSession(catalog, missionIds, facts), 5, missionIds,
    )
    const expected = new Map([
        [3010, 100], [111001, 2], [1111001, 1], [9000, 1], [12000, 1],
        [46000, 4], [11010, 1], [57010, 1], [58000, 1], [68000, 1],
        [61040, 1], [62330, 1], [41000, 8], [70000, 7], [43000, 1],
        [14000, 20000],
    ])
    for (const [missionId, progress] of expected) {
        assert.equal(DegreeComputer.compute(missionId, context, 0), progress, String(missionId))
    }
    assert.equal(context.degreeRules.get(14000).target, 12345)
})
