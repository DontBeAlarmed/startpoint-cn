"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-reward-grant-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, givePlayerItemSync, updatePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    addPlayerShopPurchaseCountsByTypeSync,
    getPlayerShopPurchaseCountSnapshotSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
    getPlayerShopPurchaseCountsByTypeSync,
} = require("../src/data/domains/shopPurchase")
const { givePlayerCharacterSync } = require("../src/lib/character")
const {
    executeGenericShopBatchPurchaseSync,
    executeGenericShopPurchaseSync,
} = require("../src/lib/event-shop-purchase")
const {
    createShopRewardPlan,
    grantShopRewardsInTransactionOwnerSync,
} = require("../src/lib/shop-reward-grant")
const {
    RewardType,
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} = require("../src/lib/types")

const COST_ITEM_ID = 910101
const REWARD_ITEM_ID = 910102
const ELEMENT_ITEM_ID = 910103
const AETHER_ITEM_ID = 910104
const EQUIPMENT_ID = 3010006
const CHARACTER_ID = 1
const DUPLICATE_ITEM_ID = 14002
const NOW_MS = Date.parse("2024-02-01T00:00:00Z")

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
        idpId: `shop-reward-${label}-${Date.now()}-${Math.random()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function shopItem(rewards) {
    return {
        costs: [{ id: COST_ITEM_ID, amount: 1 }],
        rewards,
        userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: 20,
    }
}

function dependencies() {
    return {
        transaction: operation => database.transaction(operation)(),
        getPlayer: getPlayerSync,
        updatePlayer: updatePlayerSync,
        getItem: (playerId, itemId) => getPlayerItemSync(playerId, itemId) ?? 0,
        setItem: updatePlayerItemSync,
        getPurchaseCounts: getPlayerShopPurchaseCountSnapshotSync,
        getPurchaseCountsBulk: getPlayerShopPurchaseCountsByTypeBulkSync,
        addPurchaseCounts: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
        addPurchaseCountsFromSnapshot: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
        recordManaSpent: () => {},
        grantRewards: grantShopRewardsInTransactionOwnerSync,
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

test("single shop purchase uses owner snapshot and returns final mixed reward state", () => {
    const playerId = createPlayer("single")
    updatePlayerSync({ id: playerId, freeMana: 500, freeVmoney: 20, expPool: 10 })
    givePlayerItemSync(playerId, COST_ITEM_ID, 10)
    givePlayerCharacterSync(playerId, CHARACTER_ID)
    const duplicateItemBefore = getPlayerItemSync(playerId, DUPLICATE_ITEM_ID) ?? 0
    const beforeCost = getPlayerSync(playerId)

    const measured = captureSql(() => executeGenericShopPurchaseSync({
        playerId,
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 9101,
        purchaseAmount: 1,
        shopItem: shopItem([
            { type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 2 },
            { type: ShopItemRewardType.MANA, count: 30 },
            { type: ShopItemRewardType.EXP, count: 40 },
            { type: ShopItemRewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
            { type: ShopItemRewardType.CHARACTER, id: CHARACTER_ID },
        ]),
        nowMs: NOW_MS,
        enforcePeriod: true,
    }, dependencies()))

    assert.deepEqual(measured.result.player, {
        ...beforeCost,
        freeMana: 430,
        expPool: 50,
    })
    assert.equal(measured.result.itemList[COST_ITEM_ID], 9)
    assert.equal(measured.result.itemList[REWARD_ITEM_ID], 2)
    assert.equal(measured.result.itemList[DUPLICATE_ITEM_ID], getPlayerItemSync(playerId, DUPLICATE_ITEM_ID))
    assert.equal(measured.result.itemList[DUPLICATE_ITEM_ID], duplicateItemBefore + 1)
    assert.equal(measured.result.rewardResult.equipment_list[0].equipment_id, EQUIPMENT_ID)
    const playerSelects = measured.statements.filter(statement => (
        /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(statement)
    ))
    assert.equal(playerSelects.length, 1, playerSelects.join("\n---\n"))
    assert.equal(
        measured.statements.filter(statement => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(statement)).length,
        0,
    )
})

test("owner adapter preserves source order and has no nested transaction SQL", () => {
    const plan = createShopRewardPlan([
        { type: RewardType.ITEM, id: REWARD_ITEM_ID, count: 2 },
        { type: RewardType.MANA, count: 4 },
        { type: RewardType.EXP, count: 5 },
        { type: RewardType.ELEMENT, id: ELEMENT_ITEM_ID, count: 6 },
        { type: RewardType.AETHER, id: AETHER_ITEM_ID, count: 7 },
        { type: RewardType.BEADS, count: 8 },
    ])
    assert.deepEqual(plan.entries.map(entry => entry.source), [
        { rewardIndex: 0 },
        { rewardIndex: 1 },
        { rewardIndex: 2 },
        { rewardIndex: 3 },
        { rewardIndex: 4 },
        { rewardIndex: 5 },
    ])

    const playerId = createPlayer("adapter")
    const before = getPlayerSync(playerId)
    let measured
    database.transaction(() => {
        measured = captureSql(() => grantShopRewardsInTransactionOwnerSync(playerId, [
            { type: RewardType.ITEM, id: REWARD_ITEM_ID, count: 2 },
            { type: RewardType.ITEM, id: REWARD_ITEM_ID, count: 3 },
            { type: RewardType.MANA, count: 4 },
            { type: RewardType.ELEMENT, id: ELEMENT_ITEM_ID, count: 6 },
            { type: RewardType.AETHER, id: AETHER_ITEM_ID, count: 7 },
            { type: RewardType.BEADS, count: 8 },
        ], {
            id: playerId,
            vmoney: before.vmoney,
            freeMana: before.freeMana,
            freeVmoney: before.freeVmoney,
            bondToken: before.bondToken,
            expPool: before.expPool,
        }))
    })()

    assert.deepEqual(measured.result.rewardResult.items, {
        [REWARD_ITEM_ID]: 5,
        [ELEMENT_ITEM_ID]: 6,
        [AETHER_ITEM_ID]: 7,
    })
    assert.equal(measured.result.rewardResult.items[ELEMENT_ITEM_ID], 6)
    assert.equal(measured.result.rewardResult.items[AETHER_ITEM_ID], 7)
    assert.equal(getPlayerItemSync(playerId, REWARD_ITEM_ID), 5)
    assert.deepEqual(measured.result.playerAfter, {
        freeMana: before.freeMana + 4,
        freeVmoney: before.freeVmoney + 8,
        expPool: before.expPool,
    })
    assert.equal(JSON.stringify(measured.result).includes("rewardIndex"), false)
    assert.equal(
        measured.statements.some(statement => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(statement)),
        false,
    )
    assert.equal(measured.statements.some(statement => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)), false)
})

test("bulk shop rewards cannot pay its costs and final duplicate item equals database", () => {
    const playerId = createPlayer("bulk")
    givePlayerItemSync(playerId, COST_ITEM_ID, 10)
    const result = executeGenericShopBatchPurchaseSync({
        playerId,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            {
                shopItemId: 9201,
                purchaseAmount: 1,
                shopItem: shopItem([{ type: ShopItemRewardType.ITEM, id: COST_ITEM_ID, count: 100 }]),
            },
            {
                shopItemId: 9202,
                purchaseAmount: 1,
                shopItem: shopItem([{ type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 2 }]),
            },
            {
                shopItemId: 9203,
                purchaseAmount: 1,
                shopItem: shopItem([{ type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 3 }]),
            },
        ],
        nowMs: NOW_MS,
        enforcePeriod: true,
    }, dependencies())

    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 107)
    assert.equal(result.itemList[COST_ITEM_ID], 107)
    assert.equal(result.itemList[REWARD_ITEM_ID], getPlayerItemSync(playerId, REWARD_ITEM_ID))
    assert.equal(result.itemList[REWARD_ITEM_ID], 5)
})

test("batch purchase writes count snapshots without per-item rereads", () => {
    assert.equal(
        typeof addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
        "function",
        "snapshot-owned shop count writer must exist",
    )
    const playerId = createPlayer("snapshot-counts")
    const keys = { daily: "2024-02-01", monthly: "2024-02" }
    addPlayerShopPurchaseCountsByTypeSync(playerId, ShopType.EVENT_ITEM, 9301, 2, keys)
    addPlayerShopPurchaseCountsByTypeSync(playerId, ShopType.EVENT_ITEM, 9302, 4, keys)

    let bulkReads = 0
    let individualReads = 0
    const writerCalls = []
    const batchDependencies = dependencies()
    batchDependencies.getPurchaseCounts = () => {
        individualReads++
        throw new Error("batch must not use individual count reads")
    }
    batchDependencies.getPurchaseCountsBulk = (ownerId, queries) => {
        bulkReads++
        return getPlayerShopPurchaseCountsByTypeBulkSync(ownerId, queries)
    }
    batchDependencies.addPurchaseCountsFromSnapshot = (...args) => {
        const statementStart = sqlTrace.length
        const result = addPlayerShopPurchaseCountsByTypeFromSnapshotSync(...args)
        writerCalls.push({
            currentCounts: args[5],
            statements: sqlTrace.slice(statementStart),
        })
        return result
    }
    const item = {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: -1,
    }
    const measured = captureSql(() => executeGenericShopBatchPurchaseSync({
        playerId,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            { shopItemId: 9301, purchaseAmount: 3, shopItem: item },
            { shopItemId: 9302, purchaseAmount: 2, shopItem: item },
        ],
        nowMs: NOW_MS,
        enforcePeriod: true,
    }, batchDependencies))

    assert.equal(bulkReads, 1)
    assert.equal(individualReads, 0)
    assert.deepEqual(measured.result.purchaseCounts, { 9301: 5, 9302: 6 })
    assert.deepEqual(writerCalls.map(call => call.currentCounts), [
        { daily: 2, monthly: 2, total: 2 },
        { daily: 4, monthly: 4, total: 4 },
    ])
    const writerStatements = writerCalls.flatMap(call => call.statements)
    assert.equal(
        writerStatements.some(statement => /^\s*SELECT\b/i.test(statement)),
        false,
        "snapshot writer must not issue SELECT statements",
    )
    assert.equal(
        writerStatements.filter(statement => (
            /^\s*INSERT\s+INTO\s+players_shop_purchase_counters\b/i.test(statement)
        )).length,
        6,
        "each item must write daily, monthly, and total with three UPSERTs",
    )
})

test("invalid reward rolls the shop cost back before purchase counts", () => {
    const playerId = createPlayer("invalid-reward")
    givePlayerItemSync(playerId, COST_ITEM_ID, 10)

    assert.throws(() => executeGenericShopPurchaseSync({
        playerId,
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 9251,
        purchaseAmount: 1,
        shopItem: shopItem([{ type: ShopItemRewardType.ITEM, id: REWARD_ITEM_ID, count: 0 }]),
        nowMs: NOW_MS,
        enforcePeriod: true,
    }, dependencies()), /Invalid reward grant entry/)

    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 10)
    assert.equal(getPlayerItemSync(playerId, REWARD_ITEM_ID), null)
    assert.equal(getPlayerShopPurchaseCountsByTypeSync(playerId, ShopType.EVENT_ITEM, 9251, {
        daily: "2024-02-01",
        monthly: "2024-02",
    }).total, 0)
})

test("unknown character rolls the shop cost and reward back", () => {
    const playerId = createPlayer("unknown-character")
    givePlayerItemSync(playerId, COST_ITEM_ID, 10)
    const before = getPlayerSync(playerId)

    assert.throws(() => executeGenericShopPurchaseSync({
        playerId,
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 9301,
        purchaseAmount: 1,
        shopItem: shopItem([{ type: ShopItemRewardType.CHARACTER, id: 999999999 }]),
        nowMs: NOW_MS,
        enforcePeriod: true,
    }, dependencies()), /unknown character/)

    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 10)
    assert.equal(getPlayerSync(playerId).freeMana, before.freeMana)
    assert.equal(getPlayerShopPurchaseCountsByTypeSync(playerId, ShopType.EVENT_ITEM, 9301, {
        daily: "2024-02-01",
        monthly: "2024-02",
    }).total, 0)
})

console.log("shop reward grant tests loaded")
