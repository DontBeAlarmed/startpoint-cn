"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    mergeCommonResponseFragments,
} = require("../src/lib/common-response")
const {
    projectAcquisitionCurrencyUserInfo,
    projectRewardGrantAcquisitionFragment,
} = require("../src/lib/common-response/acquisition")
const {
    createRewardGrantExecutionPlan,
    createRewardGrantExecutionResult,
} = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

test("projects only owner-provided absolute currencies with current CN wire names", () => {
    assert.deepEqual(projectAcquisitionCurrencyUserInfo({}), {})
    assert.deepEqual(projectAcquisitionCurrencyUserInfo({ freeMana: 0 }), { free_mana: 0 })
    assert.deepEqual(projectAcquisitionCurrencyUserInfo({
        freeMana: 3,
        freeVmoney: 5,
        paidVmoney: 7,
        expPool: 9,
    }), {
        free_mana: 3,
        free_vmoney: 5,
        vmoney: 7,
        exp_pool: 9,
    })
    assert.deepEqual(projectAcquisitionCurrencyUserInfo({ freeVmoney: 4 }), { free_vmoney: 4 })
})

test("rejects malformed acquisition currency after-states instead of guessing", () => {
    for (const input of [
        { freeMana: -1 },
        { freeMana: 1.5 },
        { freeVmoney: "3" },
        { paidVmoney: Number.MAX_SAFE_INTEGER + 1 },
        { expPool: Number.NaN },
    ]) {
        assert.throws(() => projectAcquisitionCurrencyUserInfo(input), TypeError)
    }
})

function fullGrantFixture() {
    const characterSnapshot = {
        character_id: 321007,
        entry_count: 1,
        exp: 0,
        bond_token_list: [{ mana_board_index: 1, status: 0 }],
        mana_board_index: 1,
        create_time: "2026-09-08T00:00:00.000Z",
        update_time: "2026-09-08T00:00:00.000Z",
        join_time: "2026-09-08T00:00:00.000Z",
    }
    const equipmentSnapshot = {
        equipment_id: 20,
        protection: false,
        level: 1,
        enhancement_level: 0,
        stack: 2,
    }
    const grant = createRewardGrantExecutionResult(
        1,
        createRewardGrantExecutionPlan([
            { type: RewardType.ITEM, id: 101, count: 5 },
            { type: RewardType.ITEM, id: 101, count: 3 },
            { type: RewardType.MANA, count: 2 },
            { type: RewardType.CHARACTER, id: 321007 },
            { type: RewardType.EQUIPMENT, id: 20, count: 2 },
        ]),
        [
            { kind: "item", item: { itemId: 101, requestedAmount: 5, acceptedAmount: 5, overflowAmount: 0, beforeAmount: 0, afterAmount: 5 } },
            { kind: "item", item: { itemId: 101, requestedAmount: 3, acceptedAmount: 3, overflowAmount: 0, beforeAmount: 5, afterAmount: 8 } },
            { kind: "currency", currency: "freeMana", requestedAmount: 2, beforeAmount: 1, afterAmount: 3 },
            { kind: "character", characterId: 321007, isNew: true, after: characterSnapshot, compensationItem: null },
            { kind: "equipment", equipmentId: 20, requestedAmount: 2, after: equipmentSnapshot },
        ],
        { playerId: 1, freeMana: 3, freeVmoney: 1, expPool: 2 },
    )
    return { grant, characterSnapshot, equipmentSnapshot }
}

test("projects a RewardGrant owner result into absolute Item/Currency/entity fragments", () => {
    const { grant, characterSnapshot, equipmentSnapshot } = fullGrantFixture()
    const fragment = projectRewardGrantAcquisitionFragment({ grant })

    assert.deepEqual(fragment, {
        user_info: { free_mana: 3, free_vmoney: 1, exp_pool: 2 },
        item_list: { 101: 8 },
        character_list: [characterSnapshot],
        equipment_list: [equipmentSnapshot],
    })
})

test("omits unpublished common fields for a grant without acquisitions", () => {
    const grant = createRewardGrantExecutionResult(
        1,
        createRewardGrantExecutionPlan([]),
        [],
        { playerId: 1, freeMana: 0, freeVmoney: 0, expPool: 0 },
    )
    const fragment = projectRewardGrantAcquisitionFragment({ grant })

    assert.deepEqual(fragment, {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
    })
    assert.equal("item_list" in fragment, false)
    assert.equal("character_list" in fragment, false)
    assert.equal("equipment_list" in fragment, false)
    assert.equal("over_max" in fragment, false)
})

test("derives ordered Mail/Sold over_max entries from the RewardGrant owner result", () => {
    const grant = createRewardGrantExecutionResult(
        1,
        createRewardGrantExecutionPlan([
            { type: RewardType.ITEM, id: 30102, count: 20 },
            { type: RewardType.ITEM, id: 1, count: 12 },
        ]),
        [
            {
                kind: "item",
                item: {
                    itemId: 30102,
                    requestedAmount: 20,
                    acceptedAmount: 5,
                    overflowAmount: 15,
                    beforeAmount: 0,
                    afterAmount: 5,
                    overflowDispositions: [
                        { kind: "mail", itemId: 30102, overflowAmount: 15 },
                    ],
                },
            },
            {
                kind: "item",
                item: {
                    itemId: 1,
                    requestedAmount: 12,
                    acceptedAmount: 8,
                    overflowAmount: 4,
                    beforeAmount: 2,
                    afterAmount: 10,
                    overflowDispositions: [
                        {
                            kind: "sold",
                            itemId: 1,
                            overflowAmount: 4,
                            soldMana: 20,
                            manaBefore: 100,
                            acceptedMana: 20,
                            overflowMana: 0,
                            manaAfter: 120,
                        },
                    ],
                },
            },
        ],
        { playerId: 1, freeMana: 120, freeVmoney: 0, expPool: 0 },
    )

    const fragment = projectRewardGrantAcquisitionFragment({ grant })

    assert.deepEqual(fragment.over_max, [
        { process_type: 1, item: { item_id: 30102, number: 15 } },
        { process_type: 2, amount_sold: 20, item: { item_id: 1, number: 4 } },
    ])
    assert.deepEqual(fragment.item_list, { 30102: 5, 1: 10 })
    assert.deepEqual(fragment.user_info, { free_mana: 120, free_vmoney: 0, exp_pool: 0 })
})

test("rejects a Character snapshot whose canonical ID differs from its owner entry", () => {
    const grant = createRewardGrantExecutionResult(
        1,
        createRewardGrantExecutionPlan([
            { type: RewardType.CHARACTER, id: 7 },
        ]),
        [{
            kind: "character",
            characterId: 7,
            isNew: true,
            after: { character_id: 8 },
            compensationItem: null,
        }],
        { playerId: 1, freeMana: 0, freeVmoney: 0, expPool: 0 },
    )

    assert.throws(
        () => projectRewardGrantAcquisitionFragment({ grant }),
        /character_id must match Character owner identity/,
    )
})

test("rejects an Equipment snapshot whose canonical ID differs from its owner entry", () => {
    const grant = createRewardGrantExecutionResult(
        1,
        createRewardGrantExecutionPlan([
            { type: RewardType.EQUIPMENT, id: 20, count: 1 },
        ]),
        [{
            kind: "equipment",
            equipmentId: 20,
            requestedAmount: 1,
            after: {
                equipment_id: 21,
                protection: false,
                level: 1,
                enhancement_level: 0,
                stack: 0,
            },
        }],
        { playerId: 1, freeMana: 0, freeVmoney: 0, expPool: 0 },
    )

    assert.throws(
        () => projectRewardGrantAcquisitionFragment({ grant }),
        /equipment_id must match Equipment owner identity/,
    )
})

test("does not share mutable containers between the owner result and the fragment", () => {
    const grant = {
        entries: [],
        assets: {
            items: [{
                itemId: 101,
                requestedAmount: 5,
                acceptedAmount: 5,
                overflowAmount: 0,
                beforeAmount: 0,
                afterAmount: 5,
            }],
            characters: [{
                characterId: 7,
                joined: true,
                after: {
                    character_id: 7,
                    level: 2,
                    bond_token_list: [{ mana_board_index: 1, status: 0 }],
                    mana_board_awake: { 1: 1 },
                },
            }],
            equipment: [{
                equipmentId: 20,
                requestedAmount: 1,
                after: { equipment_id: 20, stack: 3 },
            }],
            currencies: [],
        },
        playerAfter: { playerId: 1, freeMana: 4, freeVmoney: 6, expPool: 8 },
    }
    const fragment = projectRewardGrantAcquisitionFragment({ grant })

    grant.assets.items[0].afterAmount = 99
    grant.assets.characters[0].after.level = 99
    grant.assets.characters[0].after.bond_token_list[0].status = 99
    grant.assets.characters[0].after.mana_board_awake[1] = 99
    grant.assets.equipment[0].after.stack = 99
    grant.playerAfter.freeMana = 99

    assert.deepEqual(fragment, {
        user_info: { free_mana: 4, free_vmoney: 6, exp_pool: 8 },
        item_list: { 101: 5 },
        character_list: [{
            character_id: 7,
            level: 2,
            bond_token_list: [{ mana_board_index: 1, status: 0 }],
            mana_board_awake: { 1: 1 },
        }],
        equipment_list: [{ equipment_id: 20, stack: 3 }],
    })
})

test("composes with the C1 merge algebra as absolute last-writer patches", () => {
    const { grant, characterSnapshot, equipmentSnapshot } = fullGrantFixture()
    const fragment = projectRewardGrantAcquisitionFragment({ grant })

    const merged = mergeCommonResponseFragments([
        fragment,
        { item_list: { 101: 2, 200: 1 }, user_info: { rank_point: 5 } },
    ])

    assert.deepEqual(merged, {
        user_info: { free_mana: 3, free_vmoney: 1, exp_pool: 2, rank_point: 5 },
        item_list: { 101: 2, 200: 1 },
        character_list: [characterSnapshot],
        equipment_list: [equipmentSnapshot],
    })
})
