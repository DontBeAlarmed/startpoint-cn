"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-cap-"))
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory

const BetterSqlite3 = require("better-sqlite3")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
} = require("../src/data/domains/item")
const { withInventoryBatchContextWithinTransactionSync } = require("../src/lib/inventory")

const database = data.initializeDatabase({
    databaseFactory: databasePath => new BetterSqlite3(databasePath),
})
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "inventory-cap-test",
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const itemId = 30005
const overCapItemId = 30006
const faultItemId = 30007
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(itemId, 8, playerId)
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(overCapItemId, 12, playerId)
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(faultItemId, 1, playerId)

const capped = database.transaction(() => {
    return withInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: [itemId],
    }, context => {
        const first = context.grantWithCapacity(itemId, 5, 10)
        const second = context.grantWithCapacity(itemId, 3, 10)
        const deducted = context.deduct(itemId, 2)
        const restored = context.restore(itemId, 2)
        const flushed = context.flush()
        return { first, second, deducted, restored, flushed }
    })
})()

assert.deepEqual(capped.first, {
    itemId,
    beforeAmount: 8,
    afterAmount: 10,
    obtainedAmount: 2,
    requestedAmount: 5,
    acceptedAmount: 2,
    overflowAmount: 3,
})
assert.deepEqual(capped.second, {
    itemId,
    beforeAmount: 8,
    afterAmount: 10,
    obtainedAmount: 2,
    requestedAmount: 3,
    acceptedAmount: 0,
    overflowAmount: 3,
})
assert.equal(capped.deducted.afterAmount, 8)
assert.equal(capped.restored.afterAmount, 10)
assert.deepEqual(capped.flushed, [{
    itemId,
    beforeAmount: 8,
    afterAmount: 10,
    obtainedAmount: 2,
}])
assert.equal(getPlayerItemSync(playerId, itemId), 10)
assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 2)

const historicalOverCap = database.transaction(() => {
    return withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
        const result = context.grantWithCapacity(overCapItemId, 5, 10)
        const flushed = context.flush()
        return { result, flushed }
    })
})()
assert.deepEqual(historicalOverCap.result, {
    itemId: overCapItemId,
    beforeAmount: 12,
    afterAmount: 12,
    obtainedAmount: 0,
    requestedAmount: 5,
    acceptedAmount: 0,
    overflowAmount: 5,
})
assert.deepEqual(historicalOverCap.flushed, [{
    itemId: overCapItemId,
    beforeAmount: 12,
    afterAmount: 12,
    obtainedAmount: 0,
}])
assert.equal(getPlayerItemSync(playerId, overCapItemId), 12)
assert.equal(getPlayerCollectedItemTotalSync(playerId, overCapItemId), 0)

database.transaction(() => {
    withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
        const zero = context.grantWithCapacity(faultItemId, 0, 0)
        assert.equal(zero.acceptedAmount, 0)
        assert.equal(zero.overflowAmount, 0)
        for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => context.grantWithCapacity(faultItemId, invalid, 10), /non-negative safe integer/)
        }
        for (const invalidMax of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => context.grantWithCapacity(faultItemId, 1, invalidMax), /non-negative safe integer/)
        }
        context.flush()
    })
})()
assert.equal(getPlayerItemSync(playerId, faultItemId), 1)

database.exec(`
    CREATE TRIGGER fail_inventory_cap_total
    BEFORE INSERT ON players_collected_items
    WHEN NEW.item_id = ${faultItemId}
    BEGIN
        SELECT RAISE(ABORT, 'inventory cap fault');
    END;
`)
assert.throws(() => {
    database.transaction(() => {
        withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
            const result = context.grantWithCapacity(faultItemId, 5, 3)
            assert.equal(result.acceptedAmount, 2)
            assert.equal(result.overflowAmount, 3)
            context.flush()
        })
    })()
}, /inventory cap fault/)
assert.equal(getPlayerItemSync(playerId, faultItemId), 1)
assert.equal(getPlayerCollectedItemTotalSync(playerId, faultItemId), 0)
database.exec("DROP TRIGGER fail_inventory_cap_total")

database.transaction(() => {
    withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
        const legacyGrant = context.grant(itemId, 4)
        assert.equal(legacyGrant.afterAmount, 14)
        context.flush()
    })
})()
assert.equal(getPlayerItemSync(playerId, itemId), 14)
assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 6)

database.close()
if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
fs.rmSync(databaseDirectory, { recursive: true, force: true })
console.log("inventory cap tests passed")
