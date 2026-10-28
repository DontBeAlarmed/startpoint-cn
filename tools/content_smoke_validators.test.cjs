"use strict"

// N-02 回归：apply 冒烟预检的校验器集合覆盖 gacha 之外的可打挂面——
// shop 目录（campaign/lineup 结构）与任务表族（/load 直达面）。
// 每族一个坏内容反例：apply 预检必须以 ContentSmokeValidationError 拦下。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    ContentSmokeValidationError,
    runContentSmokeValidators,
} = require("../src/lib/content-smoke")

function repositoryWithTables(tables) {
    return { table: name => (name in tables ? tables[name] : null) }
}

function bundledShapedShopTables(overrides = {}) {
    return {
        "shop_item_campaign.json": {},
        "shop_select_item_campaign.json": {},
        "cdn_general_shop_whitelist.json": [],
        "shop_cost_item_schedule.json": {},
        "treasure_shop.json": {},
        "special_pack_shop.json": {},
        "mana_shop.json": {},
        "general_shop.json": {},
        "star_grain_shop.json": {},
        "equipment_enhancement_shop.json": {},
        "event_item_shop.json": {},
        "boss_coin_shop.json": {},
        ...overrides,
    }
}

function bundledShapedQuestTables(overrides = {}) {
    const emptyQuestTables = {}
    for (const name of [
        "main_quest.json", "ex_quest.json", "boss_battle_quest.json",
        "character_quest.json", "world_story_event_quest.json",
        "world_story_event_boss_battle_quest.json", "advent_event_quest.json",
        "daily_exp_mana_event_quest.json", "daily_week_event_quest.json",
        "challenge_dungeon_event_quest.json", "story_event_single_quest.json",
        "ranking_event_single_quest.json", "solo_time_attack_event_quest.json",
        "tower_dungeon_event_quest.json", "expert_single_event_quest.json",
        "carnival_event_quest.json", "rush_event_quest.json",
        "raid_event_quest.json", "score_attack_event_quest.json",
        "hard_multi_event_quest.json", "practice_quest.json",
    ]) {
        emptyQuestTables[name] = {}
    }
    return { ...emptyQuestTables, ...overrides }
}

function bundledShapedGachaTables(overrides = {}) {
    return {
        "gacha.json": {},
        "gacha_pool.json": {},
        "gacha_exchange_rate.json": {
            character: { 3: 1, 4: 1, 5: 1 },
            equipment: { 3: 1, 4: 1, 5: 1 },
        },
        "gacha_campaign_definitions.json": {},
        "stars_gacha_campaign.json": {},
        "character.json": {},
        "item_lookup.json": {},
        "equipment_lookup.json": {},
        "equipment_gacha_movie_probability.json": {},
        ...overrides,
    }
}

test("smoke validators pass on minimal well-formed tables", () => {
    assert.doesNotThrow(() => runContentSmokeValidators(repositoryWithTables({
        ...bundledShapedGachaTables(),
        ...bundledShapedShopTables(),
        ...bundledShapedQuestTables(),
    })))
})

test("a malformed shop campaign table is rejected by the shop validator (N-02)", () => {
    let caught
    try {
        runContentSmokeValidators(repositoryWithTables({
            ...bundledShapedGachaTables(),
            ...bundledShapedShopTables({
                "shop_select_item_campaign.json": [],
            }),
            ...bundledShapedQuestTables(),
        }))
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof ContentSmokeValidationError, "必须以 ContentSmokeValidationError 拒绝")
    assert.equal(caught.validator, "shop-catalog")
    assert.match(caught.message, /invalid shop campaign table/i)
})

test("a malformed quest table root is rejected by the quest validator (N-02)", () => {
    let caught
    try {
        runContentSmokeValidators(repositoryWithTables({
            ...bundledShapedGachaTables(),
            ...bundledShapedShopTables(),
            ...bundledShapedQuestTables({
                "main_quest.json": [],
            }),
        }))
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof ContentSmokeValidationError, "必须以 ContentSmokeValidationError 拒绝")
    assert.equal(caught.validator, "quest-content-tables")
    assert.match(caught.message, /invalid main_quest\.json content: root must be an object/i)
})

test("a malformed quest id entry is rejected by the quest validator (N-02)", () => {
    let caught
    try {
        runContentSmokeValidators(repositoryWithTables({
            ...bundledShapedGachaTables(),
            ...bundledShapedShopTables(),
            ...bundledShapedQuestTables({
                "advent_event_quest.json": { "not-a-quest-id": {} },
            }),
        }))
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof ContentSmokeValidationError)
    assert.equal(caught.validator, "quest-content-tables")
    assert.match(caught.message, /malformed quest not-a-quest-id/i)
})
