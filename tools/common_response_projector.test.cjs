"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    mergeCommonResponseFragments,
} = require("../src/lib/common-response")

test("preserves missing, placeholder, concrete empty, zero, and false semantics", () => {
    assert.deepEqual(mergeCommonResponseFragments([]), {})
    assert.deepEqual(mergeCommonResponseFragments([
        {
            user_info: null,
            item_list: null,
            character_list: null,
            equipment_list: null,
            mission_info: null,
            over_max: null,
            mail_arrived: null,
        },
    ]), {
        user_info: null,
        item_list: null,
        character_list: null,
        equipment_list: null,
        mission_info: null,
        over_max: null,
        mail_arrived: null,
    })
    assert.deepEqual(mergeCommonResponseFragments([
        {
            user_info: {},
            item_list: {},
            character_list: [],
            equipment_list: [],
            mission_info: [],
            over_max: [],
            mail_arrived: false,
        },
        {
            user_info: { free_mana: 0 },
            item_list: { 1: 0 },
            user_daily_challenge_point_list: [],
        },
        {
            user_info: null,
            item_list: null,
            character_list: null,
            equipment_list: null,
            mission_info: null,
            over_max: null,
            mail_arrived: null,
        },
    ]), {
        user_info: { free_mana: 0 },
        item_list: { 1: 0 },
        character_list: [],
        equipment_list: [],
        mission_info: [],
        over_max: [],
        mail_arrived: false,
    })
})

test("preserves the legacy empty item list without erasing an absolute item patch", () => {
    assert.deepEqual(mergeCommonResponseFragments([{ item_list: [] }]), { item_list: [] })
    assert.deepEqual(mergeCommonResponseFragments([
        { item_list: [] },
        { item_list: { 1: 5 } },
        { item_list: [] },
    ]), { item_list: { 1: 5 } })
})

test("merges user and item maps as absolute last-writer patches", () => {
    assert.deepEqual(mergeCommonResponseFragments([
        {
            user_info: { free_mana: 10, rank_point: 20 },
            item_list: { 1: 5, 2: 7 },
        },
        {
            user_info: { free_mana: 3, free_vmoney: 0, rank_point: undefined },
            item_list: { 1: 8, 3: 9 },
        },
    ]), {
        user_info: { free_mana: 3, rank_point: 20, free_vmoney: 0 },
        item_list: { 1: 8, 2: 7, 3: 9 },
    })
})

test("merges character patches by canonical ID and preserves first-seen order", () => {
    assert.deepEqual(mergeCommonResponseFragments([
        {
            character_list: [
                { character_id: 10, level: 2, mana_board_awake: { 1: 1 } },
                { character_id: 11, level: 1 },
            ],
        },
        {
            character_list: [
                { character_id: 10, level: 3, exp: 0, mana_board_awake: { 2: 1 } },
                { character_id: 12, level: 1 },
            ],
        },
    ]), {
        character_list: [
            { character_id: 10, level: 3, exp: 0, mana_board_awake: { 1: 1, 2: 1 } },
            { character_id: 11, level: 1 },
            { character_id: 12, level: 1 },
        ],
    })
})

test("rejects a character fragment without a positive canonical character_id", () => {
    assert.throws(
        () => mergeCommonResponseFragments([{ character_list: [{ id: 10 }] }]),
        /character_id/,
    )
})

test("merges equipment patches by canonical ID and preserves first-seen order", () => {
    assert.deepEqual(mergeCommonResponseFragments([
        {
            equipment_list: [
                { equipment_id: 20, level: 1, stack: 2 },
                { equipment_id: 21, level: 1 },
            ],
        },
        {
            equipment_list: [
                { equipment_id: 20, level: 2, protection: false },
                { equipment_id: 22, level: 1 },
            ],
        },
    ]), {
        equipment_list: [
            { equipment_id: 20, level: 2, stack: 2, protection: false },
            { equipment_id: 21, level: 1 },
            { equipment_id: 22, level: 1 },
        ],
    })
})

test("rejects an equipment fragment without a positive canonical equipment_id", () => {
    assert.throws(
        () => mergeCommonResponseFragments([{ equipment_list: [{ id: 20 }] }]),
        /equipment_id/,
    )
})

test("appends mission and overflow events in fragment order without deduplication", () => {
    const mission = { mission_category_id: 1, mission_id: 10, mission_reward_id: 100 }
    const overflow = { process_type: 1, item: { item_id: 30102, number: 2 } }

    assert.deepEqual(mergeCommonResponseFragments([
        { mission_info: [mission], over_max: [overflow] },
        {
            mission_info: [
                mission,
                { mission_category_id: 2, mission_id: 20, mission_reward_id: 200 },
            ],
            over_max: [
                { process_type: 2, amount_sold: 5, item: { item_id: 1, number: 1 } },
            ],
        },
    ]), {
        mission_info: [
            mission,
            mission,
            { mission_category_id: 2, mission_id: 20, mission_reward_id: 200 },
        ],
        over_max: [
            overflow,
            { process_type: 2, amount_sold: 5, item: { item_id: 1, number: 1 } },
        ],
    })
})

test("isolates the finite mutable protocol containers owned by the projection", () => {
    const input = {
        user_info: { free_mana: 10 },
        item_list: { 1: 5 },
        character_list: [{
            character_id: 10,
            level: 2,
            bond_token_list: [{ mana_board_index: 1, status: 0 }],
            mana_board_awake: { 1: 1 },
        }],
        equipment_list: [{ equipment_id: 20, level: 1 }],
        mission_info: [{ mission_category_id: 1, mission_id: 10, mission_reward_id: 100 }],
        over_max: [{ process_type: 1, item: { item_id: 30102, number: 2 } }],
    }
    const output = mergeCommonResponseFragments([input])

    input.user_info.free_mana = 99
    input.item_list[1] = 99
    input.character_list[0].level = 99
    input.character_list[0].bond_token_list[0].status = 99
    input.character_list[0].mana_board_awake[1] = 99
    input.equipment_list[0].level = 99
    input.mission_info[0].mission_id = 99
    input.over_max[0].process_type = 2
    input.over_max[0].item.number = 99

    assert.deepEqual(output, {
        user_info: { free_mana: 10 },
        item_list: { 1: 5 },
        character_list: [{
            character_id: 10,
            level: 2,
            bond_token_list: [{ mana_board_index: 1, status: 0 }],
            mana_board_awake: { 1: 1 },
        }],
        equipment_list: [{ equipment_id: 20, level: 1 }],
        mission_info: [{ mission_category_id: 1, mission_id: 10, mission_reward_id: 100 }],
        over_max: [{ process_type: 1, item: { item_id: 30102, number: 2 } }],
    })

    output.character_list[0].bond_token_list[0].status = 98
    output.character_list[0].mana_board_awake[1] = 98
    output.over_max[0].item.number = 98
    assert.deepEqual(input.character_list[0].bond_token_list, [
        { mana_board_index: 1, status: 99 },
    ])
    assert.equal(input.character_list[0].mana_board_awake[1], 99)
    assert.equal(input.over_max[0].item.number, 99)
})
