"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { projectShopPurchaseResponse } = require("../src/lib/shop/response-projector")
const { ShopType } = require("../src/lib/types")

function result(overrides = {}) {
    return {
        playerId: 1,
        shopType: ShopType.EVENT_ITEM,
        playerAfter: {
            vmoney: 1,
            freeVmoney: 2,
            paidMana: 3,
            freeMana: 4,
            bondToken: 5,
            expPool: 6,
        },
        itemAfter: [{ itemId: 10, afterAmount: 20 }],
        characters: [{ characterId: 1, joined: true, after: { character_id: 1 } }],
        equipmentRewards: [{
            equipmentId: 2,
            requestedAmount: 1,
            after: { equipment_id: 2, stack: 0 },
        }],
        joinedCharacterIds: [1],
        itemOverflowDispositions: [],
        equipmentEnhancements: [{
            shopItemId: 3,
            equipmentId: 4,
            before: { level: 5, enhancementLevel: 0, protection: false, stack: 0 },
            after: { level: 5, enhancementLevel: 2, protection: false, stack: 0 },
        }],
        passCardEffects: [],
        purchaseCounts: [],
        rewardInvalidatedFactKeys: [],
        missionSettlement: null,
        ...overrides,
    }
}

test("projects absolute owner facts without post-commit fields", () => {
    const data = projectShopPurchaseResponse(result(), 99)
    assert.deepEqual(data.user_info, {
        vmoney: 1,
        free_vmoney: 2,
        paid_mana: 3,
        free_mana: 4,
        bond_token: 5,
        exp_pool: 6,
    })
    assert.deepEqual(data.character_list, [{ character_id: 1 }])
    assert.deepEqual(data.equipment_list, [
        { equipment_id: 2, stack: 0 },
        { equipment_id: 4, protection: false, level: 5, enhancement_level: 2, stack: 0 },
    ])
    assert.deepEqual(data.item_list, { 10: 20 })
    assert.equal("mail_arrived" in data, false)
})

test("merges overflow and complete Mission delta after Shop absolute facts", () => {
    const data = projectShopPurchaseResponse(result({
        itemOverflowDispositions: [{
            kind: "mail",
            itemId: 10,
            overflowAmount: 2,
        }],
        missionSettlement: {
            missionInfo: [{ mission_category_id: 5, mission_id: 45000, mission_reward_id: 45000001 }],
            itemList: { 10: 21 },
            characterList: [{ character_id: 1, stack: 2 }],
            equipmentList: [],
            degreeIds: [45000],
            passCardPoints: {},
            userInfo: { free_mana: 7 },
        },
    }), 99)
    assert.equal(data.item_list[10], 21)
    assert.equal(data.user_info.free_mana, 7)
    assert.deepEqual(data.character_list, [{ character_id: 1, stack: 2 }])
    assert.deepEqual(data.degree_list, [{ viewer_id: 99, degree_id: 45000 }])
    assert.equal(data.over_max.length, 1)
})
