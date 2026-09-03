"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const BetterSqlite3 = require("better-sqlite3")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "item-use-cultivate-pack-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const bundledItemData = require("../assets/item_data.json")
const bundledItemPolicy = structuredClone(require("../assets/item_inventory_policy.json"))
for (const itemId of [4, 990003, 990004]) {
    bundledItemPolicy.byItemId[itemId] = {
        ...bundledItemPolicy.byItemId[14002],
        maxCount: 2_147_483_647,
    }
}
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        tableOverrides: {
            "item_inventory_policy.json": bundledItemPolicy,
            "item_data.json": {
                ...bundledItemData,
                990001: { effectKind: 22, effectValue: 0, selectRewards: [] },
                990002: { effectKind: 99, effectValue: 0 },
                990100: { effectKind: 3, effectValue: 50 },
                990003: {
                    effectKind: 22,
                    effectValue: 0,
                    selectRewards: [{ itemId: 4, amount: 1 }],
                },
                990004: {
                    effectKind: 22,
                    effectValue: 0,
                    selectRewards: Array.from({ length: 6 }, () => ({
                        itemId: 990004,
                        amount: 1,
                    })),
                },
            },
        },
    })
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
} = require("../src/data/domains/item")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const itemRoutes = require("../src/routes/api/item").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const itemUseSettlement = require("../src/lib/item-use-settlement")

const AS3_INT_MAX = 2_147_483_647

let database
let app
let nextViewerId = 850000000
const sqlStatements = []

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

async function useItem(viewerId, items) {
    return app.inject({
        method: "POST",
        url: "/item/use_item",
        payload: { viewer_id: viewerId, items },
    })
}

function decodeSuccess(response) {
    assert.equal(response.statusCode, 200, response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

function assertRejectedWithoutWrites(response, playerId, itemIds, expectedCounts = {}) {
    assert.equal(response.statusCode, 400, response.body)
    for (const itemId of itemIds) {
        assert.equal(getPlayerItemSync(playerId, itemId) ?? 0, expectedCounts[itemId] ?? 0)
    }
}

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => sqlStatements.push(sql),
        }),
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(itemRoutes, { prefix: "/item" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("999102 selectIndex 1 through 6 returns the corresponding reward item", async () => {
    const rewardItemIds = [4, 8, 12, 16, 45, 49]
    for (const [offset, rewardItemId] of rewardItemIds.entries()) {
        const { playerId, viewerId } = await createPlayer(`select-${offset}`)
        setInventoryFixtureItemExactSync(playerId, 999102, 1)

        const responseData = decodeSuccess(await useItem(viewerId, [{
            id: 999102,
            number: 1,
            selectIndex: offset + 1,
        }])).data

        assert.equal(getPlayerItemSync(playerId, 999102), 0)
        assert.equal(getPlayerItemSync(playerId, rewardItemId), 30)
        assert.equal(getPlayerCollectedItemTotalSync(playerId, rewardItemId), 30)
        assert.equal(responseData.item_list[String(999102)], 0)
        assert.equal(responseData.item_list[String(rewardItemId)], 30)
        assert.equal("user_info" in responseData, false)
    }
})

test("cultivate pack sends capped reward overflow to Mail", async () => {
    const { playerId, viewerId } = await createPlayer("cultivate-overflow")
    const rewardItemId = 8
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    setInventoryFixtureItemExactSync(playerId, rewardItemId, policy.maxCount(rewardItemId))
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, rewardItemId)

    const responseData = decodeSuccess(await useItem(viewerId, [{
        id: 999102,
        number: 1,
        selectIndex: 2,
    }])).data

    assert.equal(responseData.item_list[String(rewardItemId)], policy.maxCount(rewardItemId))
    assert.equal(getPlayerItemSync(playerId, rewardItemId), policy.maxCount(rewardItemId))
    assert.equal(getPlayerCollectedItemTotalSync(playerId, rewardItemId), collectedBefore)
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true).map(mail => ({
        type: mail.type,
        type_id: mail.type_id,
        number: mail.number,
    })), [{ type: MailType.ITEM, type_id: rewardItemId, number: 30 }])
})

test("duplicate cultivate pack entries with the same selection are aggregated", async () => {
    const { playerId, viewerId } = await createPlayer("duplicate-pack")
    setInventoryFixtureItemExactSync(playerId, 999102, 2)

    const responseData = decodeSuccess(await useItem(viewerId, [
        { id: 999102, number: 1, selectIndex: 1 },
        { id: 999102, number: 1, selectIndex: 1 },
    ])).data

    assert.equal(getPlayerItemSync(playerId, 999102), 0)
    assert.equal(getPlayerItemSync(playerId, 4), 60)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 4), 60)
    assert.equal(responseData.item_list["999102"], 0)
    assert.equal(responseData.item_list["4"], 60)
})

test("same item deduction and reward use one before count and one final count", async () => {
    const { playerId, viewerId } = await createPlayer("self-reward")
    setInventoryFixtureItemExactSync(playerId, 990004, 1)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 990004)

    const responseData = decodeSuccess(await useItem(viewerId, [
        { id: 990004, number: 1, selectIndex: 1 },
    ])).data

    assert.equal(getPlayerItemSync(playerId, 990004), 1)
    assert.equal(responseData.item_list["990004"], 1)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 990004), collectedBefore + 1)
})

test("same item reward reuses the planned inventory state without a second item read", async () => {
    const { playerId, viewerId } = await createPlayer("planned-final-count")
    setInventoryFixtureItemExactSync(playerId, 990004, 1)
    const start = sqlStatements.length

    const response = decodeSuccess(await useItem(viewerId, [
        { id: 990004, number: 1, selectIndex: 1 },
    ]))

    const itemReads = sqlStatements
        .slice(start)
        .filter(sql => /\bFROM\s+players_items\b/i.test(sql))
    assert.equal(itemReads.length, 1, itemReads.join("\n---\n"))
    assert.equal(response.data.item_list["990004"], 1)
    assert.equal(getPlayerItemSync(playerId, 990004), 1)
})

test("reward final count may reach the AS3 int maximum", async () => {
    const { playerId, viewerId } = await createPlayer("int32-boundary")
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    setInventoryFixtureItemExactSync(playerId, 4, AS3_INT_MAX - 30)

    const responseData = decodeSuccess(await useItem(viewerId, [
        { id: 999102, number: 1, selectIndex: 1 },
    ])).data

    assert.equal(getPlayerItemSync(playerId, 999102), 0)
    assert.equal(getPlayerItemSync(playerId, 4), AS3_INT_MAX)
    assert.equal(responseData.item_list["4"], AS3_INT_MAX)
})

test("reward final count above the AS3 int maximum rejects without writes", async () => {
    const { playerId, viewerId } = await createPlayer("int32-overflow")
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    setInventoryFixtureItemExactSync(playerId, 4, AS3_INT_MAX - 29)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 4)

    const response = await useItem(viewerId, [
        { id: 999102, number: 1, selectIndex: 1 },
    ])

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(getPlayerItemSync(playerId, 999102), 1)
    assert.equal(getPlayerItemSync(playerId, 4), AS3_INT_MAX - 29)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 4), collectedBefore)
})

test("duplicate cultivate pack entries with different selections reject without writes", async () => {
    const { playerId, viewerId } = await createPlayer("different-selection")
    setInventoryFixtureItemExactSync(playerId, 999102, 2)

    const response = await useItem(viewerId, [
        { id: 999102, number: 1, selectIndex: 1 },
        { id: 999102, number: 1, selectIndex: 2 },
    ])

    assertRejectedWithoutWrites(response, playerId, [999102, 4, 8], { 999102: 2 })
})

test("invalid cultivate pack requests reject without writes", async () => {
    const cases = [
        ["missing items", undefined],
        ["empty items", []],
        ["invalid items structure", null],
        ["index zero", [{ id: 999102, number: 1, selectIndex: 0 }]],
        ["index seven", [{ id: 999102, number: 1, selectIndex: 7 }]],
        ["non integer index", [{ id: 999102, number: 1, selectIndex: 1.5 }]],
        ["missing index", [{ id: 999102, number: 1 }]],
        ["missing effect", [{ id: 123456789, number: 1, selectIndex: 1 }]],
        ["missing candidates", [{ id: 990001, number: 1, selectIndex: 1 }]],
        ["unsupported effect", [{ id: 990002, number: 1, selectIndex: 1 }]],
        ["short candidates", [{ id: 990003, number: 1, selectIndex: 2 }]],
        ["invalid id", [{ id: 0, number: 1, selectIndex: 1 }]],
        ["invalid number", [{ id: 999102, number: 0, selectIndex: 1 }]],
        ["non integer number", [{ id: 999102, number: 1.5, selectIndex: 1 }]],
    ]

    for (const [label, items] of cases) {
        const { playerId, viewerId } = await createPlayer(`invalid-${label.replaceAll(" ", "-")}`)
        const response = await useItem(viewerId, items)
        assert.equal(response.statusCode, 400, `${label}: ${response.body}`)
        assert.equal(getPlayerItemSync(playerId, 999102) ?? 0, 0)
        assert.equal(getPlayerItemSync(playerId, 4) ?? 0, 0)
    }
})

test("cultivate pack inventory shortage rejects without writes", async () => {
    const { playerId, viewerId } = await createPlayer("shortage")
    setInventoryFixtureItemExactSync(playerId, 999102, 1)

    const response = await useItem(viewerId, [{ id: 999102, number: 2, selectIndex: 1 }])

    assertRejectedWithoutWrites(response, playerId, [999102, 4], { 999102: 1 })
})

test("stamina items and cultivate packs settle in one response and transaction", async () => {
    const { playerId, viewerId } = await createPlayer("mixed")
    updatePlayerSync({ id: playerId, stamina: 0, staminaHealTime: new Date() })
    setInventoryFixtureItemExactSync(playerId, 100, 1)
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    const start = sqlStatements.length

    const responseData = decodeSuccess(await useItem(viewerId, [
        { id: 100, number: 1, selectIndex: 0 },
        { id: 999102, number: 1, selectIndex: 1 },
    ])).data
    const itemReads = sqlStatements
        .slice(start)
        .filter(sql => /\bFROM\s+players_items\b/i.test(sql))

    assert.equal(itemReads.length, 1, itemReads.join("\n---\n"))
    assert.equal(getPlayerItemSync(playerId, 100), 0)
    assert.equal(getPlayerItemSync(playerId, 999102), 0)
    assert.equal(getPlayerItemSync(playerId, 4), 30)
    assert.equal(responseData.item_list["100"], 0)
    assert.equal(responseData.item_list["999102"], 0)
    assert.equal(responseData.item_list["4"], 30)
    assert.equal(typeof responseData.user_info.stamina, "number")
    assert.equal(typeof responseData.user_info.stamina_heal_time, "number")
})

test("stamina rate items preserve percentage recovery semantics", async () => {
    const { playerId, viewerId } = await createPlayer("stamina-rate")
    updatePlayerSync({ id: playerId, stamina: 0, staminaHealTime: new Date() })
    setInventoryFixtureItemExactSync(playerId, 990100, 1)

    const responseData = decodeSuccess(await useItem(viewerId, [
        { id: 990100, number: 1, selectIndex: 0 },
    ])).data

    assert.equal(getPlayerItemSync(playerId, 990100), 0)
    assert.equal(responseData.user_info.stamina, 499)
})

test("stamina use at max returns 2102 without deduction", async () => {
    const { playerId, viewerId } = await createPlayer("stamina-max")
    updatePlayerSync({
        id: playerId,
        stamina: 999,
        staminaHealTime: new Date(Date.now() - 300_000),
    })
    setInventoryFixtureItemExactSync(playerId, 100, 1)

    const response = await useItem(viewerId, [{ id: 100, number: 1, selectIndex: 0 }])

    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, 2102)
    assert.equal(getPlayerItemSync(playerId, 100), 1)
})

test("inventory shortage is reported before full-stamina 2102", async () => {
    const { playerId, viewerId } = await createPlayer("stamina-shortage-before-full")
    const originalHealTime = new Date("2026-09-01T00:00:00.000Z")
    updatePlayerSync({
        id: playerId,
        stamina: 999,
        staminaHealTime: originalHealTime,
    })

    const response = await useItem(viewerId, [{ id: 100, number: 1, selectIndex: 0 }])
    const error = response.json()
    const afterPlayer = getPlayerSync(playerId)

    assert.equal(response.statusCode, 400)
    assert.equal(error.message, "Insufficient items.")
    assert.equal(Object.hasOwn(error, "code"), false)
    assert.equal(getPlayerItemSync(playerId, 100), null)
    assert.equal(afterPlayer.stamina, 999)
    assert.equal(afterPlayer.staminaHealTime.getTime(), originalHealTime.getTime())
})

test("item use validation errors carry a stable optional result code", () => {
    const error = new itemUseSettlement.ItemUseValidationError("stamina full", 2102)
    assert.equal(error.resultCode, 2102)
})

test("settlement entry follows the callback-scoped Inventory batch topology", () => {
    assert.equal(typeof itemUseSettlement.settleItemUseInCallerTransactionSync, "function")
    const calls = []
    const recoveryTime = new Date("2026-09-02T00:00:00.000Z")
    const fakeIntent = {
        affectedItemIds: [999102, 4],
        deductions: [{ id: 999102, count: 1 }],
        rewards: [{ id: 4, count: 30 }],
        stamina: { recovery: 2 },
    }
    const fakeStaminaPlan = { current: 1, recovery: 2, after: 3, recoveryTime }
    const fakeContext = {
        readMany(itemIds) {
            calls.push(`read-many:${itemIds.join(",")}`)
            return [
                { itemId: 999102, beforeAmount: 1, afterAmount: 1, obtainedAmount: 0 },
                { itemId: 4, beforeAmount: 0, afterAmount: 0, obtainedAmount: 0 },
            ]
        },
        deduct(itemId, amount) {
            calls.push(`deduct:${itemId}:${amount}`)
        },
        grant(itemId, amount) {
            calls.push(`grant:${itemId}:${amount}`)
        },
        grantWithCapacity(itemId, amount, maxCount) {
            calls.push(`grant-cap:${itemId}:${amount}:${maxCount}`)
            return {
                itemId,
                beforeAmount: 0,
                afterAmount: amount,
                obtainedAmount: amount,
                requestedAmount: amount,
                acceptedAmount: amount,
                overflowAmount: 0,
            }
        },
        flush() {
            calls.push("flush")
            return [
                { itemId: 4, beforeAmount: 0, afterAmount: 30, obtainedAmount: 30 },
                { itemId: 999102, beforeAmount: 1, afterAmount: 0, obtainedAmount: 0 },
            ]
        },
    }

    const result = database.transaction(() => (
        itemUseSettlement.settleItemUseInCallerTransactionSync(7, { items: [] }, 999, {
            getPlayerSync(playerId) {
                assert.equal(database.inTransaction, true)
                calls.push(`read:${playerId}`)
                return { id: playerId }
            },
            createItemUseIntent(body, maxStaminaOverflow) {
                assert.equal(database.inTransaction, true)
                calls.push(`intent:${body.items.length}:${maxStaminaOverflow}`)
                return fakeIntent
            },
            withInventoryBatchContextWithinTransactionSync(options, callback) {
                assert.equal(database.inTransaction, true)
                assert.deepEqual(options, { playerId: 7, preloadItemIds: [999102, 4] })
                calls.push("batch")
                return callback(fakeContext)
            },
            createItemUseStaminaPlan(player, staminaIntent, maxStaminaOverflow) {
                assert.equal(database.inTransaction, true)
                assert.equal(player.id, 7)
                assert.deepEqual(staminaIntent, { recovery: 2 })
                assert.equal(maxStaminaOverflow, 999)
                assert.deepEqual(calls, [
                    "read:7",
                    "intent:0:999",
                    "batch",
                    "read-many:999102,4",
                ], "inventory snapshot and final-count planning must precede the stamina plan")
                calls.push("stamina-plan")
                return fakeStaminaPlan
            },
            updatePlayerSync(update) {
                assert.equal(database.inTransaction, true)
                assert.deepEqual(update, { id: 7, stamina: 3, staminaHealTime: recoveryTime })
                calls.push("stamina")
            },
        })
    ))()

    assert.deepEqual(calls, [
        "read:7",
        "intent:0:999",
        "batch",
        "read-many:999102,4",
        "stamina-plan",
        "deduct:999102:1",
        "grant-cap:4:30:2147483647",
        "stamina",
        "flush",
    ])
    assert.deepEqual(result, {
        plan: {
            inventoryChanges: [
                {
                    id: 999102,
                    beforeCount: 1,
                    deductionCount: 1,
                    rewardCount: 0,
                    finalCount: 0,
                },
                {
                    id: 4,
                    beforeCount: 0,
                    deductionCount: 0,
                    rewardCount: 30,
                    finalCount: 30,
                },
            ],
            rewards: [{ id: 4, count: 30 }],
            stamina: fakeStaminaPlan,
        },
        itemList: { "999102": 0, "4": 30 },
    })

    const routeSource = fs.readFileSync(path.join(__dirname, "../src/routes/api/item.ts"), "utf8")
    const useItemBlock = routeSource.split('fastify.post("/use_item"')[1]
        .split('fastify.post("/sell"')[0]
    const transactionIndex = useItemBlock.indexOf("getDb().transaction")
    const settlementIndex = useItemBlock.indexOf("settleItemUseInCallerTransactionSync")
    assert.ok(transactionIndex >= 0)
    assert.ok(settlementIndex > transactionIndex)
    assert.equal(useItemBlock.includes("getPlayerSync("), false)
    assert.equal(useItemBlock.includes("createItemUseIntent("), false)
    assert.equal(useItemBlock.includes("withInventoryBatchContextWithinTransactionSync("), false)
})

test("settlement entry rejects use outside an active caller transaction", () => {
    const unexpected = () => { throw new Error("dependency must not run") }
    assert.throws(
        () => itemUseSettlement.settleItemUseInCallerTransactionSync(7, {}, 999, {
            getPlayerSync: unexpected,
            createItemUseIntent: unexpected,
            createItemUseStaminaPlan: unexpected,
            updatePlayerSync: unexpected,
            withInventoryBatchContextWithinTransactionSync: unexpected,
        }),
        /active caller transaction/i,
    )
})

test("item use and sell production paths have no direct Item persistence dependency", () => {
    const productionFiles = [
        "../src/lib/item-use-settlement.ts",
        "../src/lib/item-sell.ts",
    ]
    const forbidden = [
        "data/domains/item",
        "players_items",
        "players_collected_items",
    ]

    for (const relativeFile of productionFiles) {
        const source = fs.readFileSync(path.join(__dirname, relativeFile), "utf8")
        assert.match(source, /from "\.\/inventory"/)
        for (const primitive of forbidden) {
            assert.equal(source.includes(primitive), false, `${relativeFile} still uses ${primitive}`)
        }
    }
})

test("later reward write failure rolls back packs, earlier rewards, and collected facts", async t => {
    const { playerId, viewerId } = await createPlayer("reward-rollback")
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    setInventoryFixtureItemExactSync(playerId, 999101, 1)
    database.exec(`
        CREATE TRIGGER reject_cultivate_reward
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = 3
        BEGIN SELECT RAISE(ABORT, 'forced cultivate reward failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_cultivate_reward"))

    const response = await useItem(viewerId, [
        { id: 999102, number: 1, selectIndex: 1 },
        { id: 999101, number: 1, selectIndex: 1 },
    ])

    assert.equal(response.statusCode, 500, response.body)
    assert.equal(getPlayerItemSync(playerId, 999102), 1)
    assert.equal(getPlayerItemSync(playerId, 999101), 1)
    assert.equal(getPlayerItemSync(playerId, 4), null)
    assert.equal(getPlayerItemSync(playerId, 3), null)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 4), 0)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 3), 0)
})

test("mixed stamina and pack settlement fully rolls back when reward SQL fails", async t => {
    const { playerId, viewerId } = await createPlayer("mixed-reward-rollback")
    const originalHealTime = new Date(Date.now() - 60_000)
    updatePlayerSync({ id: playerId, stamina: 0, staminaHealTime: originalHealTime })
    setInventoryFixtureItemExactSync(playerId, 100, 1)
    setInventoryFixtureItemExactSync(playerId, 999102, 1)
    database.exec(`
        CREATE TRIGGER reject_mixed_cultivate_reward
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = 4
        BEGIN SELECT RAISE(ABORT, 'forced mixed cultivate reward failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_mixed_cultivate_reward"))

    const response = await useItem(viewerId, [
        { id: 100, number: 1, selectIndex: 0 },
        { id: 999102, number: 1, selectIndex: 1 },
    ])

    const player = getPlayerSync(playerId)
    assert.equal(response.statusCode, 500, response.body)
    assert.equal(player.stamina, 0)
    assert.equal(player.staminaHealTime.getTime(), originalHealTime.getTime())
    assert.equal(getPlayerItemSync(playerId, 100), 1)
    assert.equal(getPlayerItemSync(playerId, 999102), 1)
    assert.equal(getPlayerItemSync(playerId, 4), null)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 4), 0)
})
