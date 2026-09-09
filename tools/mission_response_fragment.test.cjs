"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    projectMissionSettlementFragment,
} = require("../src/lib/mission/response-fragment")

function settlement(overrides = {}) {
    return {
        missionInfo: [{ mission_category_id: 1, mission_id: 10, mission_reward_id: 100 }],
        itemList: { 1: 8 },
        characterList: [{
            character_id: 10,
            evolution_level: 2,
            mana_board_awake: { 1: 1 },
            illustration_settings: [1],
        }],
        equipmentList: [{
            equipment_id: 20,
            protection: false,
            level: 1,
            enhancement_level: 0,
            stack: 0,
        }],
        degreeIds: [30],
        passCardPoints: {},
        userInfo: { free_mana: 0, is_newbie: false },
        itemOverflowDispositions: [{ kind: "mail", itemId: 99, overflowAmount: 2 }],
        ...overrides,
    }
}

test("Mission settlement maps finite Common fields and keeps Degree endpoint-local", () => {
    const fragment = projectMissionSettlementFragment(settlement())

    assert.deepEqual(fragment.common.mission_info, [{
        mission_category_id: 1,
        mission_id: 10,
        mission_reward_id: 100,
    }])
    assert.deepEqual(fragment.common.item_list, { 1: 8 })
    assert.deepEqual(fragment.common.character_list, [{
        character_id: 10,
        evolution_level: 2,
        mana_board_awake: { 1: 1 },
        illustration_settings: [1],
    }])
    assert.deepEqual(fragment.common.equipment_list, [{
        equipment_id: 20,
        protection: false,
        level: 1,
        enhancement_level: 0,
        stack: 0,
    }])
    assert.deepEqual(fragment.common.user_info, { free_mana: 0, is_newbie: false })
    assert.deepEqual(fragment.common.over_max, [{
        process_type: 1,
        item: { item_id: 99, number: 2 },
    }])
    assert.deepEqual(fragment.degreeIds, [30])
    assert.equal("degree_list" in fragment.common, false)
    assert.equal("pass_card_points" in fragment.common, false)
})

test("Mission fragment owns copied finite containers instead of settlement containers", () => {
    const source = settlement()
    const fragment = projectMissionSettlementFragment(source)

    source.missionInfo[0].mission_id = 11
    source.itemList[1] = 9
    source.characterList[0].mana_board_awake[1] = 9
    source.characterList[0].illustration_settings[0] = 9
    source.equipmentList[0].stack = 9

    assert.equal(fragment.common.mission_info[0].mission_id, 10)
    assert.equal(fragment.common.item_list[1], 8)
    assert.equal(fragment.common.character_list[0].mana_board_awake[1], 1)
    assert.equal(fragment.common.character_list[0].illustration_settings[0], 1)
    assert.equal(fragment.common.equipment_list[0].stack, 0)

    assert.notEqual(fragment.common.mission_info, source.missionInfo)
    assert.notEqual(fragment.common.item_list, source.itemList)
    assert.notEqual(fragment.common.character_list, source.characterList)
    assert.notEqual(fragment.common.equipment_list, source.equipmentList)
    assert.notEqual(fragment.common.over_max[0].item, source.itemOverflowDispositions[0])
})

test("Mission fragment preserves empty, null, zero/false, missing, and no-overflow semantics", () => {
    const empty = projectMissionSettlementFragment(settlement({
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        userInfo: { free_mana: 0, is_newbie: false },
        itemOverflowDispositions: [],
    }))
    assert.deepEqual(empty.common.mission_info, [])
    assert.deepEqual(empty.common.item_list, {})
    assert.deepEqual(empty.common.character_list, [])
    assert.deepEqual(empty.common.equipment_list, [])
    assert.deepEqual(empty.common.user_info, { free_mana: 0, is_newbie: false })
    assert.equal("over_max" in empty.common, false)
    assert.deepEqual(empty.degreeIds, [])

    const nullable = projectMissionSettlementFragment({
        missionInfo: null,
        itemList: null,
        characterList: null,
        equipmentList: null,
        degreeIds: [],
        passCardPoints: {},
    })
    assert.equal(nullable.common.mission_info, null)
    assert.equal(nullable.common.item_list, null)
    assert.equal(nullable.common.character_list, null)
    assert.equal(nullable.common.equipment_list, null)
    assert.equal("user_info" in nullable.common, false)
    assert.equal("over_max" in nullable.common, false)
})

test("Mission fragment path is dependency-free from DB, Content, Mail, routes, and owners", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/lib/mission/response-fragment.ts"),
        "utf8",
    )
    assert.doesNotMatch(source, /(?:from\s+["'][^"']*(?:\/data|\/content|\/routes|mail|growth)|require\([^)]*(?:\/data|\/content|\/routes|mail|growth))/i)
    const loaded = Object.keys(require.cache)
    assert.equal(loaded.some(file => /\/src\/(data|content|routes)\//.test(file)), false)
    assert.equal(loaded.some(file => /(?:mail|settlement-write|growth-owner)/i.test(file)), false)
})

console.log("mission response fragment tests passed")
