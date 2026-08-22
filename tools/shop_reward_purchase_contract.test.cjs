"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    executeGenericShopBatchPurchaseSync,
    executeGenericShopPurchaseSync,
} = require("../src/lib/event-shop-purchase")
const {
    RewardType,
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} = require("../src/lib/types")

const CHARACTER_ID = 1
const DUPLICATE_ITEM_ID = 14002
const EQUIPMENT_ID = 3010006

function createHarness(failAt) {
    let state = {
        player: {
            id: 7,
            vmoney: 50,
            freeMana: 500,
            freeVmoney: 20,
            bondToken: 3,
            expPool: 10,
        },
        items: { 10: 40 },
        purchaseCounts: {},
        characters: new Set([CHARACTER_ID]),
        equipment: {},
        manaSpent: 0,
        passCardPoints: 0,
    }
    const grantCalls = []
    let getPlayerCalls = 0

    function cloneState() {
        return {
            ...state,
            player: { ...state.player },
            items: { ...state.items },
            purchaseCounts: { ...state.purchaseCounts },
            characters: new Set(state.characters),
            equipment: { ...state.equipment },
        }
    }

    const dependencies = {
        transaction(operation) {
            const before = cloneState()
            try {
                return operation()
            } catch (error) {
                state = before
                throw error
            }
        },
        getPlayer: () => {
            getPlayerCalls++
            return { ...state.player }
        },
        updatePlayer(player) { state.player = { ...player } },
        getItem: (_playerId, itemId) => state.items[itemId] ?? 0,
        setItem(_playerId, itemId, amount) { state.items[itemId] = amount },
        getPurchaseCounts(_playerId, _shopType, shopItemId) {
            const count = state.purchaseCounts[shopItemId] ?? 0
            return { daily: count, monthly: count, total: count }
        },
        getPurchaseCountsBulk(_playerId, queries) {
            return new Map(queries.map(query => {
                const count = state.purchaseCounts[query.shopItemId] ?? 0
                return [
                    `${query.shopType}:${query.shopItemId}:${query.keys.daily}:${query.keys.monthly}`,
                    { daily: count, monthly: count, total: count },
                ]
            }))
        },
        addPurchaseCounts(_playerId, _shopType, shopItemId, amount, _keys, currentCounts) {
            state.purchaseCounts[shopItemId] = currentCounts.total + amount
            if (failAt === "purchase-count") throw new Error("injected purchase-count failure")
            const count = state.purchaseCounts[shopItemId]
            return { daily: count, monthly: count, total: count }
        },
        addPurchaseCountsFromSnapshot(
            _playerId, _shopType, shopItemId, amount, _keys, currentCounts,
        ) {
            state.purchaseCounts[shopItemId] = currentCounts.total + amount
            if (failAt === "purchase-count") throw new Error("injected purchase-count failure")
            const count = state.purchaseCounts[shopItemId]
            return {
                daily: currentCounts.daily + amount,
                monthly: currentCounts.monthly + amount,
                total: count,
            }
        },
        recordManaSpent(_playerId, amount) {
            state.manaSpent += amount
            if (failAt === "mission") throw new Error("injected mission failure")
        },
        grantPassCardPoints(_playerId, amount) {
            state.passCardPoints += amount
            if (failAt === "pass-card") throw new Error("injected pass-card failure")
        },
        grantRewards(playerId, rewards, knownPlayerBefore) {
            grantCalls.push({ playerId, rewards, knownPlayerBefore })
            const result = {
                user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
                character_list: [],
                joined_character_id_list: [],
                equipment_list: [],
                items: {},
            }
            for (const reward of rewards) {
                switch (reward.type) {
                    case RewardType.ITEM: {
                        const next = (state.items[reward.id] ?? 0) + reward.count
                        state.items[reward.id] = next
                        result.items[String(reward.id)] = next
                        break
                    }
                    case RewardType.MANA:
                        state.player.freeMana += reward.count
                        result.user_info.free_mana += reward.count
                        break
                    case RewardType.EXP:
                        state.player.expPool += reward.count
                        result.user_info.exp_pool += reward.count
                        break
                    case RewardType.EQUIPMENT:
                        state.equipment[reward.id] = (state.equipment[reward.id] ?? 0) + reward.count
                        result.equipment_list = [{ equipment_id: reward.id, stack: state.equipment[reward.id] - 1 }]
                        break
                    case RewardType.CHARACTER:
                        if (state.characters.has(reward.id)) {
                            const next = (state.items[DUPLICATE_ITEM_ID] ?? 0) + 1
                            state.items[DUPLICATE_ITEM_ID] = next
                            result.items[String(DUPLICATE_ITEM_ID)] = next
                        } else {
                            state.characters.add(reward.id)
                            result.character_list.push({ character_id: reward.id })
                            result.joined_character_id_list.push(reward.id)
                        }
                        break
                }
            }
            const playerAfter = {
                freeMana: state.player.freeMana,
                freeVmoney: state.player.freeVmoney,
                expPool: state.player.expPool,
            }
            return { ...result, rewardResult: result, playerAfter }
        },
    }

    return {
        dependencies,
        getState: () => cloneState(),
        getPlayerCalls: () => getPlayerCalls,
        grantCalls,
    }
}

function mixedShopItem(overrides = {}) {
    return {
        costs: [{ id: 10, amount: 3 }],
        rewards: [
            { type: ShopItemRewardType.ITEM, id: 20, count: 2 },
            { type: ShopItemRewardType.MANA, count: 30 },
            { type: ShopItemRewardType.EXP, count: 40 },
            { type: ShopItemRewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
            { type: ShopItemRewardType.CHARACTER, id: CHARACTER_ID },
        ],
        userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: 10,
        ...overrides,
    }
}

test("single purchase representative fixture preserves mixed reward order and final state", () => {
    const harness = createHarness()
    const result = executeGenericShopPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 101,
        purchaseAmount: 1,
        shopItem: mixedShopItem(),
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)

    assert.deepEqual(harness.grantCalls[0].rewards.map(reward => reward.type), [
        RewardType.ITEM,
        RewardType.MANA,
        RewardType.EXP,
        RewardType.EQUIPMENT,
        RewardType.CHARACTER,
    ])
    assert.deepEqual(result.player, {
        id: 7,
        vmoney: 50,
        freeMana: 430,
        freeVmoney: 20,
        bondToken: 3,
        expPool: 50,
    })
    assert.deepEqual(result.itemList, { 10: 37, 20: 2, [DUPLICATE_ITEM_ID]: 1 })
    assert.equal(result.rewardResult.equipment_list[0].equipment_id, EQUIPMENT_ID)
    assert.deepEqual(harness.getState().items, { 10: 37, 20: 2, [DUPLICATE_ITEM_ID]: 1 })
})

test("single purchase passes its post-cost player snapshot to the reward owner", () => {
    const harness = createHarness()
    executeGenericShopPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 101,
        purchaseAmount: 1,
        shopItem: mixedShopItem(),
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)

    assert.deepEqual(harness.grantCalls[0].knownPlayerBefore, {
        id: 7,
        vmoney: 50,
        freeMana: 400,
        freeVmoney: 20,
        bondToken: 3,
        expPool: 10,
    })
    assert.equal(harness.getPlayerCalls(), 1, "owner path must not re-read player after grant")
})

test("bulk representative fixture validates aggregate costs before granting rewards", () => {
    const harness = createHarness()
    const result = executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            { shopItemId: 101, purchaseAmount: 1, shopItem: mixedShopItem() },
            {
                shopItemId: 102,
                purchaseAmount: 1,
                shopItem: mixedShopItem({
                    costs: [{ id: 10, amount: 5 }],
                    rewards: [{ type: ShopItemRewardType.ITEM, id: 10, count: 100 }],
                    userCost: undefined,
                }),
            },
        ],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)

    assert.deepEqual(result.itemList, { 10: 132, 20: 2, [DUPLICATE_ITEM_ID]: 1 })
    assert.equal(harness.getState().items[10], 132)
    assert.deepEqual(result.purchaseCounts, { 101: 1, 102: 1 })
})

test("late shop writes roll costs, rewards, counts, mission facts, and pass points back", () => {
    for (const failAt of ["purchase-count", "mission", "pass-card"]) {
        const harness = createHarness(failAt)
        const before = harness.getState()
        assert.throws(() => executeGenericShopPurchaseSync({
            playerId: 7,
            shopType: ShopType.EVENT_ITEM,
            shopItemId: 103,
            purchaseAmount: 1,
            shopItem: mixedShopItem({ passCardPoints: failAt === "pass-card" ? 5 : undefined }),
            nowMs: Date.parse("2024-02-01T00:00:00Z"),
            enforcePeriod: true,
        }, harness.dependencies), new RegExp(`injected ${failAt} failure`))
        assert.deepEqual(harness.getState(), before, failAt)
    }
})
