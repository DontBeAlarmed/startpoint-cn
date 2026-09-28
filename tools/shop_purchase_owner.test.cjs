"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-owner-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const COST_ITEM_ID = 910101
const REWARD_ITEM_ID = 910102
const OVERFLOW_ITEM_ID = 910103
const SOLD_ITEM_ID = 910104
const EQUIPMENT_ID = 3010006
const testItemPolicy = structuredClone(require("../assets/item_inventory_policy.json"))
for (const itemId of [COST_ITEM_ID, REWARD_ITEM_ID]) {
    testItemPolicy.byItemId[itemId] = {
        ...testItemPolicy.byItemId[14002],
        maxCount: 1000,
        sellable: false,
    }
}
testItemPolicy.byItemId[OVERFLOW_ITEM_ID] = {
    ...testItemPolicy.byItemId[14002],
    maxCount: 2,
    sellable: false,
}
testItemPolicy.byItemId[SOLD_ITEM_ID] = {
    ...testItemPolicy.byItemId[99],
    maxCount: 2,
    sellable: true,
    salePrice: 50,
}
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        tableOverrides: { "item_inventory_policy.json": testItemPolicy },
    })

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerEquipmentSync,
    insertPlayerEquipmentSync,
} = require("../src/data/domains/equipment")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerMailsSync } = require("../src/data/domains/mail")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { getPlayerPassCardStateSync } = require("../src/data/domains/pass-card")
const { ensurePlayerCategoryMissionProgressSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    getPlayerShopPurchaseCountsByTypeSync,
} = require("../src/data/domains/shopPurchase")
const {
    selectPlayerShopCampaignLineupSync,
} = require("../src/data/domains/shop-campaign-lineup")
const {
    grantInventoryFixtureItemSync,
    setInventoryFixtureItemExactSync,
} = require("./helpers/inventory-fixture.cjs")
const { executeShopPurchaseSync } = require("../src/lib/shop/owner")
const { ShopPurchasePlanError } = require("../src/lib/shop/purchase-plan")
const {
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} = require("../src/lib/types")

const VIRTUAL_MS = Date.parse("2024-08-10T04:00:00Z")
const REAL_MS = Date.parse("2026-08-27T00:00:00Z")
let database
let sqlTrace = null

function captureSql(operation) {
    const statements = []
    sqlTrace = statements
    try {
        return { result: operation(), statements }
    } finally {
        sqlTrace = null
    }
}

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `shop-owner-${label}-${Date.now()}-${Math.random()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function item(overrides = {}) {
    return {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: 99,
        ...overrides,
    }
}

function catalog(shopType, definitions, options = {}) {
    const entries = {}
    const equipmentGroupProductIds = {}
    for (const [idText, definition] of Object.entries(definitions)) {
        const shopItemId = Number(idText)
        const scope = definition.scope ?? { kind: "ordinary" }
        entries[`${shopType}:${shopItemId}`] = {
            kind: "purchase",
            shopType,
            shopItemId,
            item: definition.item,
            periods: [{
                availableFrom: definition.item.availableFrom,
                availableUntil: definition.item.availableUntil,
            }],
            listed: true,
            scope,
        }
        if (scope.kind === "equipmentEnhancement") {
            const key = `${scope.categoryId}:${scope.groupId}:${scope.equipmentId}`
            ;(equipmentGroupProductIds[key] ??= []).push(shopItemId)
        }
    }
    for (const ids of Object.values(equipmentGroupProductIds)) ids.sort((a, b) => a - b)
    return {
        entries,
        productIdsByType: { [shopType]: Object.keys(definitions).map(Number) },
        eventProductIds: {},
        bossProductIds: {},
        equipmentGroupProductIds,
        rewardProductKeys: {},
        scheduleRowsByMonth: {},
        ...options,
    }
}

function execute(playerId, shopType, definitions, entries, options = {}) {
    return executeShopPurchaseSync({
        playerId,
        shopType,
        entries,
        virtualNowMs: options.virtualNowMs ?? VIRTUAL_MS,
        purchasePeriodNowMs: REAL_MS,
        resetHour: 5,
        catalog: catalog(shopType, definitions),
    })
}

function counts(playerId, shopType, itemId) {
    return getPlayerShopPurchaseCountsByTypeSync(
        playerId,
        shopType,
        itemId,
        { daily: "2026-08-27", monthly: "2026-08" },
    )
}

function snapshot(playerId, itemIds = []) {
    const player = getPlayerSync(playerId)
    return {
        resources: {
            vmoney: player.vmoney,
            freeVmoney: player.freeVmoney,
            paidMana: player.paidMana,
            freeMana: player.freeMana,
            bondToken: player.bondToken,
            expPool: player.expPool,
        },
        items: Object.fromEntries(itemIds.map(id => [id, getPlayerItemSync(playerId, id) ?? 0])),
        mails: getPlayerMailsSync(playerId),
    }
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlTrace !== null) sqlTrace.push(statement)
            },
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("single owner continues Mana payment into rewards and one shared Inventory state", () => {
    const playerId = createPlayer("single")
    updatePlayerSync({ id: playerId, freeMana: 500, paidMana: 0, expPool: 10 })
    grantInventoryFixtureItemSync(playerId, COST_ITEM_ID, 10)
    const result = execute(playerId, ShopType.EVENT_ITEM, {
        101: { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
            costs: [{ id: COST_ITEM_ID, amount: 1 }],
            rewards: [
                { type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 2 },
                { type: ShopItemRewardType.MANA, count: 30 },
                { type: ShopItemRewardType.EXP, count: 40 },
            ],
        }) },
    }, [{ shopItemId: 101, purchaseAmount: 1 }])

    assert.equal(result.playerAfter.freeMana, 430)
    assert.equal(result.playerAfter.expPool, 50)
    assert.equal(getPlayerSync(playerId).freeMana, 430)
    const itemAfter = Object.fromEntries(result.itemAfter.map(entry => [entry.itemId, entry.afterAmount]))
    assert.equal(itemAfter[COST_ITEM_ID], 9)
    assert.equal(itemAfter[REWARD_ITEM_ID], 2)
    assert.deepEqual(counts(playerId, ShopType.EVENT_ITEM, 101), {
        daily: 1, monthly: 1, total: 1,
    })
})

test("Event bulk authorizes one selected lineup and allows public campaign products", () => {
    const playerId = createPlayer("campaign")
    updatePlayerSync({ id: playerId, freeMana: 500 })
    const definitions = {
        101: {
            item: item({ userCost: { type: ShopItemUserCostType.MANA, amount: 10 } }),
            scope: {
                kind: "event",
                eventType: 4,
                eventId: 100001,
                campaignId: 10,
                lineupId: 1001,
            },
        },
        102: {
            item: item(),
            scope: {
                kind: "event",
                eventType: 4,
                eventId: 100001,
                campaignId: 20,
            },
        },
    }
    const before = snapshot(playerId)
    assert.throws(
        () => execute(playerId, ShopType.EVENT_ITEM, definitions, [
            { shopItemId: 102, purchaseAmount: 1 },
            { shopItemId: 101, purchaseAmount: 1 },
        ]),
        error => error instanceof ShopPurchasePlanError,
    )
    assert.deepEqual(snapshot(playerId), before)

    const wrongPlayerId = createPlayer("campaign-wrong")
    updatePlayerSync({ id: wrongPlayerId, freeMana: 500 })
    assert.equal(selectPlayerShopCampaignLineupSync(
        wrongPlayerId,
        ShopType.EVENT_ITEM,
        10,
        9999,
        new Date(VIRTUAL_MS),
    ), "inserted")
    const wrongBefore = snapshot(wrongPlayerId)
    assert.throws(
        () => execute(wrongPlayerId, ShopType.EVENT_ITEM, definitions, [
            { shopItemId: 101, purchaseAmount: 1 },
        ]),
        error => error instanceof ShopPurchasePlanError,
    )
    assert.deepEqual(snapshot(wrongPlayerId), wrongBefore)

    assert.equal(
        selectPlayerShopCampaignLineupSync(
            playerId,
            ShopType.EVENT_ITEM,
            10,
            1001,
            new Date(VIRTUAL_MS),
        ),
        "inserted",
    )
    const result = execute(playerId, ShopType.EVENT_ITEM, definitions, [
        { shopItemId: 102, purchaseAmount: 1 },
        { shopItemId: 101, purchaseAmount: 1 },
    ])
    assert.deepEqual(result.purchaseCounts.map(entry => entry.shopItemId), [101, 102])
    assert.equal(result.playerAfter.freeMana, 490)
})

test("Item overflow Mail is part of the owner transaction", () => {
    const playerId = createPlayer("overflow")
    setInventoryFixtureItemExactSync(playerId, OVERFLOW_ITEM_ID, 2)
    const result = execute(playerId, ShopType.BOSS_COIN, {
        201: { item: item({
            rewards: [{ type: ShopItemRewardType.ITEM, id: OVERFLOW_ITEM_ID, count: 1 }],
        }) },
    }, [{ shopItemId: 201, purchaseAmount: 1 }])
    assert.equal(result.itemAfter.find(entry => entry.itemId === OVERFLOW_ITEM_ID).afterAmount, 2)
    assert.equal(result.itemOverflowDispositions[0].kind, "mail")
    assert.equal(getPlayerMailsSync(playerId).length, 1)
})

test("sellable overflow uses the payment after-state for Mana capacity", () => {
    const playerId = createPlayer("sold")
    updatePlayerSync({ id: playerId, freeMana: 500, paidMana: 0 })
    setInventoryFixtureItemExactSync(playerId, SOLD_ITEM_ID, 2)
    const result = execute(playerId, ShopType.BOSS_COIN, {
        202: { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
            rewards: [{ type: ShopItemRewardType.ITEM, id: SOLD_ITEM_ID, count: 1 }],
        }) },
    }, [{ shopItemId: 202, purchaseAmount: 1 }])
    assert.equal(result.playerAfter.freeMana, 450)
    assert.equal(getPlayerSync(playerId).freeMana, 450)
    assert.equal(result.itemOverflowDispositions[0].kind, "sold")
    assert.equal(result.itemOverflowDispositions[0].acceptedMana, 50)
    assert.equal(result.itemOverflowDispositions[0].overflowMana, 0)
})

test("Equipment effect validates current stage before payment and returns absolute after-state", () => {
    const playerId = createPlayer("equipment")
    updatePlayerSync({ id: playerId, freeMana: 500 })
    insertPlayerEquipmentSync(playerId, EQUIPMENT_ID, {
        level: 5,
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })
    const scope = {
        kind: "equipmentEnhancement",
        categoryId: 3,
        groupId: 21,
        equipmentId: EQUIPMENT_ID,
    }
    const definitions = {
        301: { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 10 },
            shopCategoryId: 3,
            groupId: 21,
            stage: 1,
            equipmentId: EQUIPMENT_ID,
            enhancementMaxLevel: 10,
            requireAwakeningLevel: 5,
        }), scope },
        302: { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 10 },
            shopCategoryId: 3,
            groupId: 21,
            stage: 2,
            equipmentId: EQUIPMENT_ID,
            enhancementMaxLevel: 20,
            requireAwakeningLevel: 5,
        }), scope },
    }
    const before = snapshot(playerId)
    assert.throws(
        () => execute(playerId, ShopType.TREASURE_EQUIPMENT, definitions, [
            { shopItemId: 302, purchaseAmount: 1 },
        ]),
        error => error instanceof ShopPurchasePlanError,
    )
    assert.deepEqual(snapshot(playerId), before)

    const result = execute(playerId, ShopType.TREASURE_EQUIPMENT, definitions, [
        { shopItemId: 301, purchaseAmount: 2 },
    ])
    assert.equal(result.equipmentEnhancements[0].before.enhancementLevel, 0)
    assert.equal(result.equipmentEnhancements[0].after.enhancementLevel, 2)
    assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_ID).enhancementLevel, 2)
    assert.equal(result.playerAfter.freeMana, 480)
})

test("Pass Card effect is prepared before mutation and reports absolute point", () => {
    const playerId = createPlayer("pass")
    const result = execute(playerId, ShopType.SPECIAL_PACK, {
        401: { item: item({ passCardPoints: 4 }) },
    }, [{ shopItemId: 401, purchaseAmount: 2 }])
    assert.deepEqual(result.passCardEffects, [{
        shopItemId: 401,
        eventId: 3,
        pointAfter: 8,
    }])
    assert.equal(getPlayerPassCardStateSync(playerId, 3).point, 8)
})

test("Treasure Mana purchase publishes counters and preserves complete Mission settlement", () => {
    const playerId = createPlayer("treasure-mission")
    updatePlayerSync({ id: playerId, freeMana: 500 })
    ensurePlayerCategoryMissionProgressSync(playerId, 5, 45000, 99_900)
    const result = execute(playerId, ShopType.TREASURE, {
        450: { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
        }) },
    }, [{ shopItemId: 450, purchaseAmount: 1 }])
    assert.equal(getActiveMissionCountersSync(playerId).totalUsedManaCount, 100)
    assert.notEqual(result.missionSettlement, null)
    assert.ok(result.missionSettlement.missionInfo.some(info => (
        info.mission_category_id === 5 && info.mission_id === 45000
    )))
    assert.ok(result.missionSettlement.degreeIds.includes(45000))
    assert.ok(
        Array.isArray(result.missionSettlement.missionInfo)
        && typeof result.missionSettlement.itemList === "object"
        && Array.isArray(result.missionSettlement.characterList)
        && Array.isArray(result.missionSettlement.equipmentList)
        && Array.isArray(result.missionSettlement.degreeIds)
        && typeof result.missionSettlement.passCardPoints === "object"
    )
    assert.equal(result.playerAfter.freeMana, getPlayerSync(playerId).freeMana)
})

test("Mission counter failure after count write rolls the entire purchase back", () => {
    const playerId = createPlayer("mission-rollback")
    updatePlayerSync({ id: playerId, freeMana: 500 })
    grantInventoryFixtureItemSync(playerId, COST_ITEM_ID, 10)
    const before = snapshot(playerId, [COST_ITEM_ID, REWARD_ITEM_ID])
    database.exec(`
        CREATE TRIGGER fail_shop_owner_mission
        BEFORE INSERT ON players_active_mission_counters
        BEGIN SELECT RAISE(ABORT, 'injected mission failure'); END
    `)
    try {
        assert.throws(() => execute(playerId, ShopType.TREASURE, {
            451: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                costs: [{ id: COST_ITEM_ID, amount: 1 }],
                rewards: [{ type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 1 }],
            }) },
        }, [{ shopItemId: 451, purchaseAmount: 1 }]), /injected mission failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_mission")
    }
    assert.deepEqual(snapshot(playerId, [COST_ITEM_ID, REWARD_ITEM_ID]), before)
    assert.deepEqual(counts(playerId, ShopType.TREASURE, 451), {
        daily: 0, monthly: 0, total: 0,
    })
})

test("late count failure rolls payment, Item deduction, reward and Mail back", () => {
    const playerId = createPlayer("rollback")
    updatePlayerSync({ id: playerId, freeMana: 500 })
    grantInventoryFixtureItemSync(playerId, COST_ITEM_ID, 10)
    setInventoryFixtureItemExactSync(playerId, OVERFLOW_ITEM_ID, 2)
    const before = snapshot(playerId, [COST_ITEM_ID, OVERFLOW_ITEM_ID])
    database.exec(`
        CREATE TRIGGER fail_shop_owner_count
        BEFORE INSERT ON players_shop_purchase_counters
        BEGIN SELECT RAISE(ABORT, 'injected count failure'); END
    `)
    try {
        assert.throws(() => execute(playerId, ShopType.EVENT_ITEM, {
            501: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                costs: [{ id: COST_ITEM_ID, amount: 1 }],
                rewards: [{ type: ShopItemRewardType.ITEM, id: OVERFLOW_ITEM_ID, count: 1 }],
            }) },
        }, [{ shopItemId: 501, purchaseAmount: 1 }]), /injected count failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_count")
    }
    assert.deepEqual(snapshot(playerId, [COST_ITEM_ID, OVERFLOW_ITEM_ID]), before)
})

test("late count failure also rolls Equipment and Pass effects back", () => {
    const equipmentPlayerId = createPlayer("equipment-rollback")
    updatePlayerSync({ id: equipmentPlayerId, freeMana: 500 })
    insertPlayerEquipmentSync(equipmentPlayerId, EQUIPMENT_ID, {
        level: 5,
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })
    const scope = {
        kind: "equipmentEnhancement",
        categoryId: 3,
        groupId: 21,
        equipmentId: EQUIPMENT_ID,
    }
    database.exec(`
        CREATE TRIGGER fail_shop_owner_effect_count
        BEFORE INSERT ON players_shop_purchase_counters
        BEGIN SELECT RAISE(ABORT, 'injected effect count failure'); END
    `)
    try {
        assert.throws(() => execute(equipmentPlayerId, ShopType.TREASURE_EQUIPMENT, {
            601: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 10 },
                shopCategoryId: 3,
                groupId: 21,
                stage: 1,
                equipmentId: EQUIPMENT_ID,
                enhancementMaxLevel: 10,
                requireAwakeningLevel: 5,
            }), scope },
        }, [{ shopItemId: 601, purchaseAmount: 1 }]), /injected effect count failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_effect_count")
    }
    assert.equal(getPlayerEquipmentSync(equipmentPlayerId, EQUIPMENT_ID).enhancementLevel, 0)
    assert.equal(getPlayerSync(equipmentPlayerId).freeMana, 500)

    const passPlayerId = createPlayer("pass-rollback")
    database.exec(`
        CREATE TRIGGER fail_shop_owner_pass_count
        BEFORE INSERT ON players_shop_purchase_counters
        BEGIN SELECT RAISE(ABORT, 'injected pass count failure'); END
    `)
    try {
        assert.throws(() => execute(passPlayerId, ShopType.SPECIAL_PACK, {
            602: { item: item({ passCardPoints: 4 }) },
        }, [{ shopItemId: 602, purchaseAmount: 1 }]), /injected pass count failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_pass_count")
    }
    assert.equal(getPlayerPassCardStateSync(passPlayerId, 3).point, 0)
})

test("Reward and Mail faults roll payment and Inventory back at their own failure points", () => {
    const rewardPlayerId = createPlayer("reward-fault")
    updatePlayerSync({ id: rewardPlayerId, freeMana: 500 })
    const rewardBefore = snapshot(rewardPlayerId)
    database.exec(`
        CREATE TRIGGER fail_shop_owner_reward
        BEFORE INSERT ON players_equipment
        BEGIN SELECT RAISE(ABORT, 'injected reward failure'); END
    `)
    try {
        assert.throws(() => execute(rewardPlayerId, ShopType.EVENT_ITEM, {
            650: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                rewards: [{ type: ShopItemRewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 }],
            }) },
        }, [{ shopItemId: 650, purchaseAmount: 1 }]), /injected reward failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_reward")
    }
    assert.deepEqual(snapshot(rewardPlayerId), rewardBefore)
    assert.equal(getPlayerEquipmentSync(rewardPlayerId, EQUIPMENT_ID), null)

    const mailPlayerId = createPlayer("mail-fault")
    updatePlayerSync({ id: mailPlayerId, freeMana: 500 })
    setInventoryFixtureItemExactSync(mailPlayerId, OVERFLOW_ITEM_ID, 2)
    const mailBefore = snapshot(mailPlayerId, [OVERFLOW_ITEM_ID])
    database.exec(`
        CREATE TRIGGER fail_shop_owner_mail
        BEFORE INSERT ON players_mails
        BEGIN SELECT RAISE(ABORT, 'injected mail failure'); END
    `)
    try {
        assert.throws(() => execute(mailPlayerId, ShopType.EVENT_ITEM, {
            651: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                rewards: [{ type: ShopItemRewardType.ITEM, id: OVERFLOW_ITEM_ID, count: 1 }],
            }) },
        }, [{ shopItemId: 651, purchaseAmount: 1 }]), /injected mail failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_mail")
    }
    assert.deepEqual(snapshot(mailPlayerId, [OVERFLOW_ITEM_ID]), mailBefore)
})

test("Equipment and Pass write faults roll preceding payment and RewardGrant back", () => {
    const equipmentPlayerId = createPlayer("equipment-write-fault")
    updatePlayerSync({ id: equipmentPlayerId, freeMana: 500 })
    insertPlayerEquipmentSync(equipmentPlayerId, EQUIPMENT_ID, {
        level: 5,
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })
    const scope = {
        kind: "equipmentEnhancement",
        categoryId: 3,
        groupId: 21,
        equipmentId: EQUIPMENT_ID,
    }
    database.exec(`
        CREATE TRIGGER fail_shop_owner_equipment_write
        BEFORE UPDATE ON players_equipment
        BEGIN SELECT RAISE(ABORT, 'injected equipment failure'); END
    `)
    try {
        assert.throws(() => execute(equipmentPlayerId, ShopType.TREASURE_EQUIPMENT, {
            660: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                shopCategoryId: 3,
                groupId: 21,
                stage: 1,
                equipmentId: EQUIPMENT_ID,
                enhancementMaxLevel: 10,
                requireAwakeningLevel: 5,
            }), scope },
        }, [{ shopItemId: 660, purchaseAmount: 1 }]), /injected equipment failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_equipment_write")
    }
    assert.equal(getPlayerSync(equipmentPlayerId).freeMana, 500)
    assert.equal(getPlayerEquipmentSync(equipmentPlayerId, EQUIPMENT_ID).enhancementLevel, 0)

    const passPlayerId = createPlayer("pass-write-fault")
    updatePlayerSync({ id: passPlayerId, freeMana: 500 })
    database.exec(`
        CREATE TRIGGER fail_shop_owner_pass_write
        BEFORE INSERT ON players_pass_cards
        BEGIN SELECT RAISE(ABORT, 'injected pass failure'); END
    `)
    try {
        assert.throws(() => execute(passPlayerId, ShopType.SPECIAL_PACK, {
            661: { item: item({
                userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
                passCardPoints: 4,
            }) },
        }, [{ shopItemId: 661, purchaseAmount: 1 }]), /injected pass failure/)
    } finally {
        database.exec("DROP TRIGGER fail_shop_owner_pass_write")
    }
    assert.equal(getPlayerSync(passPlayerId).freeMana, 500)
    assert.equal(getPlayerPassCardStateSync(passPlayerId, 3).point, 0)
})

test("owner preserves legacy first-touch snapshot metadata for the count writer", () => {
    const playerId = createPlayer("legacy")
    database.prepare(`
        INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
        VALUES (?, 701, 2)
    `).run(playerId)
    const result = execute(playerId, ShopType.EVENT_ITEM, {
        701: { item: item() },
    }, [{ shopItemId: 701, purchaseAmount: 1 }])
    assert.equal(result.purchaseCounts[0].total, 3)
    assert.equal(database.prepare(`
        SELECT 1 FROM players_shop_purchases
        WHERE player_id = ? AND shop_item_id = 701
    `).get(playerId), undefined)
})

test("500-entry owner admission keeps reads and transaction structure constant", () => {
    const playerId = createPlayer("500")
    updatePlayerSync({ id: playerId, freeMana: 1000 })
    grantInventoryFixtureItemSync(playerId, COST_ITEM_ID, 1000)
    const definitions = {}
    const entries = []
    for (let index = 0; index < 500; index++) {
        const shopItemId = 800000 + index
        definitions[shopItemId] = { item: item({
            userCost: { type: ShopItemUserCostType.MANA, amount: 1 },
            costs: [{ id: COST_ITEM_ID, amount: 1 }],
            rewards: [
                { type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 1 },
                { type: ShopItemRewardType.MANA, count: 1 },
            ],
        }) }
        entries.push({ shopItemId, purchaseAmount: 1 })
    }
    const measured = captureSql(() => execute(
        playerId,
        ShopType.EVENT_ITEM,
        definitions,
        entries,
    ))
    assert.equal(measured.result.purchaseCounts.length, 500)
    assert.equal(getPlayerSync(playerId).freeMana, 1000)
    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 500)
    assert.equal(getPlayerItemSync(playerId, REWARD_ITEM_ID), 500)
    // One read above is the owner's after-write player snapshot for the
    // in-transaction Active Mission publication.
    assert.equal(measured.statements.filter(statement => (
        /FROM players\s+WHERE id =/i.test(statement)
    )).length, 2)
    assert.equal(measured.statements.filter(statement => (
        /CROSS JOIN players_shop_purchase_counters/i.test(statement)
    )).length, 1)
    assert.equal(measured.statements.filter(statement => (
        /CROSS JOIN players_shop_purchases/i.test(statement)
    )).length, 1)
    assert.equal(measured.statements.filter(statement => (
        /FROM players_shop_campaign_lineups/i.test(statement)
    )).length, 0)
    assert.equal(measured.statements.filter(statement => /^\s*BEGIN\b/i.test(statement)).length, 1)
    assert.equal(measured.statements.filter(statement => /^\s*COMMIT\b/i.test(statement)).length, 1)
    assert.ok(measured.statements.filter(statement => (
        /FROM players_items/i.test(statement)
    )).length <= 1)
    assert.ok(measured.statements.filter(statement => (
        /^\s*UPDATE players\s+SET/i.test(statement)
    )).length <= 2)
    assert.ok(measured.statements.filter(statement => (
        /(?:INSERT INTO|UPDATE) players_items/i.test(statement)
    )).length <= 2)
})
