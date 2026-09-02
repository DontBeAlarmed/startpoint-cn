"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-owner-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
} = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    InventoryInsufficientItemError,
    InventoryTransactionError,
    InventoryValidationError,
    deductInventoryItemSync,
    grantInventoryItemSync,
    grantInventoryItemWithinTransactionSync,
    restoreInventoryItemSync,
    restoreInventoryItemWithinTransactionSync,
    withInventoryBatchContextWithinTransactionSync,
} = require("../src/lib/inventory")
const { InventorySqliteRepository } = require("../src/lib/inventory/sqlite-repository")

let database

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function setItem(playerId, itemId, amount) {
    database.prepare(`
        INSERT INTO players_items (id, amount, player_id)
        VALUES (?, ?, ?)
        ON CONFLICT(id, player_id) DO UPDATE SET amount = excluded.amount
    `).run(itemId, amount, playerId)
}

function getCollectedRow(playerId, itemId) {
    return database.prepare(`
        SELECT total_obtained
        FROM players_collected_items
        WHERE player_id = ? AND item_id = ?
    `).get(playerId, itemId)
}

function getCollectedStorage(playerId, itemId) {
    return database.prepare(`
        SELECT total_obtained, typeof(total_obtained) AS storage_type
        FROM players_collected_items
        WHERE player_id = ? AND item_id = ?
    `).get(playerId, itemId)
}

test.before(() => {
    database = data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("standalone grant, deduct, restore and zero state expose absolute frozen results", () => {
    const playerId = createPlayer("standalone-semantics")
    const itemId = 810001

    const granted = grantInventoryItemSync({ playerId, itemId, amount: 5 })
    assert.deepEqual(granted, {
        itemId,
        beforeAmount: 0,
        afterAmount: 5,
        obtainedAmount: 5,
    })
    assert.equal(Object.isFrozen(granted), true)
    assert.equal(getPlayerItemSync(playerId, itemId), 5)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 5)
    assert.deepEqual(getCollectedStorage(playerId, itemId), {
        total_obtained: 5,
        storage_type: "integer",
    })

    const deducted = deductInventoryItemSync({ playerId, itemId, amount: 5 })
    assert.deepEqual(deducted, {
        itemId,
        beforeAmount: 5,
        afterAmount: 0,
        obtainedAmount: 0,
    })
    assert.equal(getPlayerItemSync(playerId, itemId), 0, "after=0 remains an explicit owned row")
    assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 5)

    const restored = restoreInventoryItemSync({ playerId, itemId, amount: 4 })
    assert.deepEqual(restored, {
        itemId,
        beforeAmount: 0,
        afterAmount: 4,
        obtainedAmount: 0,
    })
    assert.equal(getPlayerItemSync(playerId, itemId), 4)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 5)

    const zeroExisting = grantInventoryItemSync({ playerId, itemId, amount: 0 })
    assert.equal(zeroExisting.afterAmount, 4)
    assert.equal(zeroExisting.obtainedAmount, 0)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 5)

    const absentItemId = 810002
    const zeroAbsent = restoreInventoryItemSync({ playerId, itemId: absentItemId, amount: 0 })
    assert.deepEqual(zeroAbsent, {
        itemId: absentItemId,
        beforeAmount: 0,
        afterAmount: 0,
        obtainedAmount: 0,
    })
    assert.equal(
        getPlayerItemSync(playerId, absentItemId),
        0,
        "a requested business mutation performs one absolute upsert even at zero",
    )
})

test("mixed grant, deduct and restore are order-independent and flush once per table", t => {
    const operations = [
        ["grant", 4],
        ["deduct", 3],
        ["restore", 2],
    ]
    const permutations = [
        [0, 1, 2], [0, 2, 1], [1, 0, 2],
        [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]

    for (const [scenarioIndex, order] of permutations.entries()) {
        const playerId = createPlayer(`mixed-${scenarioIndex}`)
        const itemId = 811000 + scenarioIndex
        setItem(playerId, itemId, 10)
        database.prepare(`
            INSERT INTO players_collected_items (player_id, item_id, total_obtained)
            VALUES (?, ?, 7)
        `).run(playerId, itemId)
        const observed = []
        const functionName = `observe_inventory_mix_${playerId}`
        const itemTrigger = `observe_inventory_item_${playerId}`
        const obtainedTrigger = `observe_inventory_obtained_${playerId}`
        database.function(functionName, value => observed.push(String(value)))
        database.exec(`
            CREATE TRIGGER ${itemTrigger}
            AFTER UPDATE ON players_items
            WHEN NEW.player_id = ${playerId} AND NEW.id = ${itemId}
            BEGIN SELECT ${functionName}('item'); END;

            CREATE TRIGGER ${obtainedTrigger}
            AFTER UPDATE ON players_collected_items
            WHEN NEW.player_id = ${playerId} AND NEW.item_id = ${itemId}
            BEGIN SELECT ${functionName}('obtained'); END;
        `)
        t.after(() => database.exec(`
            DROP TRIGGER IF EXISTS ${itemTrigger};
            DROP TRIGGER IF EXISTS ${obtainedTrigger};
        `))

        const result = database.transaction(() => (
            withInventoryBatchContextWithinTransactionSync({
                playerId,
                preloadItemIds: [itemId],
            }, context => {
                for (const operationIndex of order) {
                    const [kind, amount] = operations[operationIndex]
                    context[kind](itemId, amount)
                }
                assert.deepEqual(context.results(), [{
                    itemId,
                    beforeAmount: 10,
                    afterAmount: 13,
                    obtainedAmount: 4,
                }])
                return context.flush()[0]
            })
        ))()

        assert.deepEqual(result, {
            itemId,
            beforeAmount: 10,
            afterAmount: 13,
            obtainedAmount: 4,
        })
        assert.equal(getPlayerItemSync(playerId, itemId), 13)
        assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 11)
        assert.deepEqual(observed, ["item", "obtained"])
    }
})

test("deduct sufficiency uses request-start inventory and cannot spend grant or restore", () => {
    for (const order of ["grant-first", "restore-first"]) {
        const playerId = createPlayer(`deduct-before-${order}`)
        const itemId = order === "grant-first" ? 812001 : 812002
        setItem(playerId, itemId, 1)

        assert.throws(() => database.transaction(() => (
            withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
                if (order === "grant-first") context.grant(itemId, 10)
                else context.restore(itemId, 10)
                context.deduct(itemId, 2)
            })
        ))(), error => {
            assert.ok(error instanceof InventoryInsufficientItemError)
            assert.equal(error.beforeAmount, 1)
            assert.equal(error.requestedDeduction, 2)
            return true
        })
        assert.equal(getPlayerItemSync(playerId, itemId), 1)
        assert.equal(getCollectedRow(playerId, itemId), undefined)
    }
})

test("standalone owns commit, rejects active transactions and rolls back a late obtained failure", t => {
    const playerId = createPlayer("standalone-transaction")
    const itemId = 813001
    setItem(playerId, itemId, 2)

    assert.throws(() => database.transaction(() => (
        grantInventoryItemSync({ playerId, itemId, amount: 1 })
    ))(), error => (
        error instanceof InventoryTransactionError
        && error.reason === "ACTIVE_TRANSACTION_NOT_ALLOWED"
    ))
    assert.equal(getPlayerItemSync(playerId, itemId), 2)

    const triggerName = `reject_inventory_obtained_${playerId}`
    database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON players_collected_items
        WHEN NEW.player_id = ${playerId} AND NEW.item_id = ${itemId}
        BEGIN SELECT RAISE(ABORT, 'forced obtained failure'); END;
    `)
    t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    assert.throws(
        () => grantInventoryItemSync({ playerId, itemId, amount: 3 }),
        /forced obtained failure/,
    )
    assert.equal(getPlayerItemSync(playerId, itemId), 2, "absolute write rolls back")
    assert.equal(getCollectedRow(playerId, itemId), undefined)
})

test("within-transaction commands require the caller transaction and obey its rollback", () => {
    const playerId = createPlayer("source-outer")
    const itemId = 814001
    setItem(playerId, itemId, 6)

    assert.throws(
        () => grantInventoryItemWithinTransactionSync({ playerId, itemId, amount: 2 }),
        error => error instanceof InventoryTransactionError
            && error.reason === "TRANSACTION_REQUIRED",
    )

    assert.throws(() => database.transaction(() => {
        const result = grantInventoryItemWithinTransactionSync({ playerId, itemId, amount: 2 })
        assert.equal(result.afterAmount, 8)
        throw new Error("late source failure")
    })(), /late source failure/)
    assert.equal(getPlayerItemSync(playerId, itemId), 6)
    assert.equal(getCollectedRow(playerId, itemId), undefined)

    const committed = database.transaction(() => (
        restoreInventoryItemWithinTransactionSync({ playerId, itemId, amount: 3 })
    ))()
    assert.equal(committed.afterAmount, 9)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, itemId), 0)
})

test("within grant savepoint rolls back its partial writes when the outer caller catches", t => {
    const playerId = createPlayer("within-savepoint")
    const itemId = 814101
    const sentinelItemId = 814102
    setItem(playerId, itemId, 2)
    const triggerName = `reject_inventory_within_obtained_${playerId}`
    database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON players_collected_items
        WHEN NEW.player_id = ${playerId} AND NEW.item_id = ${itemId}
        BEGIN SELECT RAISE(ABORT, 'forced within obtained failure'); END;
    `)
    t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    let caught = null
    database.transaction(() => {
        try {
            grantInventoryItemWithinTransactionSync({ playerId, itemId, amount: 3 })
        } catch (error) {
            caught = error
        }
        database.prepare(`
            INSERT INTO players_items (id, amount, player_id)
            VALUES (?, 1, ?)
        `).run(sentinelItemId, playerId)
    })()

    assert.match(String(caught), /forced within obtained failure/)
    assert.equal(getPlayerItemSync(playerId, itemId), 2, "within absolute write rolls back to its savepoint")
    assert.equal(getCollectedRow(playerId, itemId), undefined)
    assert.equal(getPlayerItemSync(playerId, sentinelItemId), 1, "outer transaction continues and commits")
})

test("batch callback scope guards entry, escape, callback failure and one flush", () => {
    const playerId = createPlayer("batch-guards")
    const itemId = 815001
    setItem(playerId, itemId, 3)

    assert.throws(
        () => withInventoryBatchContextWithinTransactionSync({ playerId }, () => undefined),
        error => error instanceof InventoryTransactionError
            && error.reason === "TRANSACTION_REQUIRED",
    )

    let escaped
    database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [itemId],
        }, context => {
            escaped = context
        })
    ))()
    for (const operation of [
        () => escaped.read(itemId),
        () => escaped.readMany([itemId]),
        () => escaped.grant(itemId, 1),
        () => escaped.deduct(itemId, 1),
        () => escaped.restore(itemId, 1),
        () => escaped.results(),
        () => escaped.flush(),
    ]) {
        assert.throws(operation, error => (
            error instanceof InventoryTransactionError
            && error.reason === "BATCH_CONTEXT_CLOSED"
        ))
    }

    let thrownEscaped
    assert.throws(() => database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
            thrownEscaped = context
            throw new Error("forced callback failure")
        })
    ))(), /forced callback failure/)
    database.transaction(() => {
        assert.throws(() => thrownEscaped.read(itemId), error => (
            error instanceof InventoryTransactionError
            && error.reason === "BATCH_CONTEXT_CLOSED"
        ))
    })()

    database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
            context.grant(itemId, 2)
            const flushed = context.flush()
            assert.equal(flushed[0].afterAmount, 5)
            for (const operation of [
                () => context.read(itemId),
                () => context.readMany([itemId]),
                () => context.grant(itemId, 1),
                () => context.deduct(itemId, 1),
                () => context.restore(itemId, 1),
                () => context.results(),
                () => context.flush(),
            ]) {
                assert.throws(operation, error => (
                    error instanceof InventoryTransactionError
                    && error.reason === "BATCH_CONTEXT_CLOSED"
                ))
            }
        })
    ))()
})

test("batch context captured from transaction A stays closed across later transactions", () => {
    const playerId = createPlayer("batch-cross-transaction")
    const itemId = 815101
    setItem(playerId, itemId, 3)

    let escaped
    database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [itemId],
        }, context => {
            escaped = context
        })
    ))()

    database.transaction(() => setItem(playerId, itemId, 20))()
    database.transaction(() => {
        assert.throws(() => escaped.grant(itemId, 1), error => (
            error instanceof InventoryTransactionError
            && error.reason === "BATCH_CONTEXT_CLOSED"
        ))
        assert.throws(() => escaped.flush(), error => (
            error instanceof InventoryTransactionError
            && error.reason === "BATCH_CONTEXT_CLOSED"
        ))
    })()
    assert.equal(getPlayerItemSync(playerId, itemId), 20)
})

test("RewardGrant-like batch coalesces repeated items and returns stable projections", t => {
    const playerId = createPlayer("reward-batch")
    const itemIds = [816003, 816001, 816002]
    setItem(playerId, 816001, 1)
    const observed = []
    const functionName = `observe_inventory_reward_${playerId}`
    const itemTrigger = `observe_inventory_reward_item_${playerId}`
    const obtainedTrigger = `observe_inventory_reward_obtained_${playerId}`
    database.function(functionName, (tableName, itemId) => observed.push(`${tableName}:${itemId}`))
    database.exec(`
        CREATE TRIGGER ${itemTrigger}
        AFTER INSERT ON players_items
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT ${functionName}('item', NEW.id); END;

        CREATE TRIGGER ${obtainedTrigger}
        AFTER INSERT ON players_collected_items
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT ${functionName}('obtained', NEW.item_id); END;
    `)
    t.after(() => database.exec(`
        DROP TRIGGER IF EXISTS ${itemTrigger};
        DROP TRIGGER IF EXISTS ${obtainedTrigger};
    `))

    const results = database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: itemIds,
        }, context => {
            context.grant(816003, 1)
            context.grant(816001, 2)
            context.grant(816003, 4)
            context.grant(816002, 3)
            assert.deepEqual(context.readMany([816003, 816001]).map(row => row.itemId), [816001, 816003])
            return context.flush()
        })
    ))()

    assert.deepEqual(results, [
        { itemId: 816001, beforeAmount: 1, afterAmount: 3, obtainedAmount: 2 },
        { itemId: 816002, beforeAmount: 0, afterAmount: 3, obtainedAmount: 3 },
        { itemId: 816003, beforeAmount: 0, afterAmount: 5, obtainedAmount: 5 },
    ])
    assert.deepEqual(observed.sort(), [
        "item:816002",
        "item:816003",
        "obtained:816001",
        "obtained:816002",
        "obtained:816003",
    ])
    assert.equal(getPlayerItemSync(playerId, 816003), 5)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 816003), 5)
})

test("Battle-like restore writes inventory once and never records obtained", t => {
    const playerId = createPlayer("battle-restore")
    const itemId = 817001
    setItem(playerId, itemId, 1)
    const writes = []
    const functionName = `observe_inventory_restore_${playerId}`
    const triggerName = `observe_inventory_restore_item_${playerId}`
    database.function(functionName, amount => writes.push(amount))
    database.exec(`
        CREATE TRIGGER ${triggerName}
        AFTER UPDATE ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${itemId}
        BEGIN SELECT ${functionName}(NEW.amount); END;
    `)
    t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    const result = database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
            context.restore(itemId, 2)
            context.restore(itemId, 3)
            return context.flush()[0]
        })
    ))()
    assert.deepEqual(result, {
        itemId,
        beforeAmount: 1,
        afterAmount: 6,
        obtainedAmount: 0,
    })
    assert.deepEqual(writes, [6])
    assert.equal(getCollectedRow(playerId, itemId), undefined)
})

test("explicit preload uses one batch inventory read and avoids per-item reads", () => {
    const playerId = createPlayer("preload")
    const itemIds = [818003, 818001, 818002]
    setItem(playerId, 818001, 1)
    setItem(playerId, 818003, 3)

    let batchReads = 0
    let singleReads = 0
    const originalBatchRead = InventorySqliteRepository.prototype.readItemsByIdsSync
    const originalSingleRead = InventorySqliteRepository.prototype.readItemSync
    InventorySqliteRepository.prototype.readItemsByIdsSync = function (...args) {
        batchReads += 1
        return originalBatchRead.apply(this, args)
    }
    InventorySqliteRepository.prototype.readItemSync = function (...args) {
        singleReads += 1
        return originalSingleRead.apply(this, args)
    }
    try {
        database.transaction(() => (
            withInventoryBatchContextWithinTransactionSync({
                playerId,
                preloadItemIds: itemIds,
            }, context => {
                context.grant(818001, 1)
                context.restore(818002, 2)
                context.deduct(818003, 1)
                context.readMany([818003, 818002, 818001])
                context.flush()
            })
        ))()
    } finally {
        InventorySqliteRepository.prototype.readItemsByIdsSync = originalBatchRead
        InventorySqliteRepository.prototype.readItemSync = originalSingleRead
    }
    assert.equal(batchReads, 1)
    assert.equal(singleReads, 0)
})

test("invalid inputs, stored state and safe-integer overflow fail closed", () => {
    const playerId = createPlayer("safe-integers")
    const itemId = 819001

    for (const command of [
        { playerId: 0, itemId, amount: 1 },
        { playerId, itemId: 0, amount: 1 },
        { playerId, itemId, amount: -1 },
        { playerId, itemId, amount: 1.5 },
        { playerId, itemId, amount: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
        assert.throws(() => grantInventoryItemSync(command), InventoryValidationError)
    }

    setItem(playerId, itemId, Number.MAX_SAFE_INTEGER)
    assert.throws(
        () => grantInventoryItemSync({ playerId, itemId, amount: 1 }),
        error => error instanceof InventoryValidationError
            && error.reason === "SAFE_INTEGER_OVERFLOW",
    )
    assert.equal(getPlayerItemSync(playerId, itemId), Number.MAX_SAFE_INTEGER)

    const negativeItemId = 819002
    setItem(playerId, negativeItemId, -1)
    assert.throws(
        () => restoreInventoryItemSync({ playerId, itemId: negativeItemId, amount: 1 }),
        error => error instanceof InventoryValidationError
            && error.reason === "INVALID_STORED_STATE",
    )
    assert.equal(getPlayerItemSync(playerId, negativeItemId), -1)
})

test("collected-total overflow and SQLite faults roll the complete standalone mutation back", t => {
    const playerId = createPlayer("faults")
    const overflowItemId = 820001
    setItem(playerId, overflowItemId, 2)
    database.prepare(`
        INSERT INTO players_collected_items (player_id, item_id, total_obtained)
        VALUES (?, ?, ?)
    `).run(playerId, overflowItemId, Number.MAX_SAFE_INTEGER)

    assert.throws(
        () => grantInventoryItemSync({ playerId, itemId: overflowItemId, amount: 1 }),
        error => error instanceof InventoryValidationError
            && error.reason === "SAFE_INTEGER_OVERFLOW",
    )
    assert.equal(getPlayerItemSync(playerId, overflowItemId), 2)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, overflowItemId), Number.MAX_SAFE_INTEGER)

    const rejectedItemId = 820002
    setItem(playerId, rejectedItemId, 4)
    const triggerName = `reject_inventory_absolute_${playerId}`
    database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${rejectedItemId}
        BEGIN SELECT RAISE(ABORT, 'forced absolute write failure'); END;
    `)
    t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))
    assert.throws(
        () => restoreInventoryItemSync({ playerId, itemId: rejectedItemId, amount: 2 }),
        /forced absolute write failure/,
    )
    assert.equal(getPlayerItemSync(playerId, rejectedItemId), 4)

    const unknownPlayerId = Number.MAX_SAFE_INTEGER - 1000
    assert.throws(
        () => grantInventoryItemSync({ playerId: unknownPlayerId, itemId: 1, amount: 1 }),
        error => error instanceof InventoryValidationError
            && error.reason === "INVALID_STORED_STATE",
    )
})

test("real-valued collected state is rejected without changing Item or storage type", () => {
    const playerId = createPlayer("collected-real")
    const itemId = 820101
    setItem(playerId, itemId, 4)
    database.prepare(`
        INSERT INTO players_collected_items (player_id, item_id, total_obtained)
        VALUES (?, ?, 1.5)
    `).run(playerId, itemId)
    assert.deepEqual(getCollectedStorage(playerId, itemId), {
        total_obtained: 1.5,
        storage_type: "real",
    })

    assert.throws(
        () => grantInventoryItemSync({ playerId, itemId, amount: 1 }),
        error => error instanceof InventoryValidationError
            && error.reason === "INVALID_STORED_STATE",
    )
    assert.equal(getPlayerItemSync(playerId, itemId), 4)
    assert.deepEqual(getCollectedStorage(playerId, itemId), {
        total_obtained: 1.5,
        storage_type: "real",
    })
})

test("a mid-batch SQLite fault rolls back earlier absolute and obtained writes", t => {
    const playerId = createPlayer("batch-fault")
    const firstItemId = 821001
    const secondItemId = 821002
    const triggerName = `reject_inventory_second_${playerId}`
    database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${secondItemId}
        BEGIN SELECT RAISE(ABORT, 'forced second item failure'); END;
    `)
    t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    assert.throws(() => database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [secondItemId, firstItemId],
        }, context => {
            context.grant(secondItemId, 2)
            context.grant(firstItemId, 1)
            context.flush()
        })
    ))(), /forced second item failure/)

    assert.equal(getPlayerItemSync(playerId, firstItemId), null)
    assert.equal(getPlayerItemSync(playerId, secondItemId), null)
    assert.equal(getCollectedRow(playerId, firstItemId), undefined)
    assert.equal(getCollectedRow(playerId, secondItemId), undefined)
})

test("a caller-owned foreign-key fault fails closed and restores the outer state", () => {
    const playerId = createPlayer("foreign-key")
    const itemId = 822001

    assert.throws(() => database.transaction(() => (
        withInventoryBatchContextWithinTransactionSync({ playerId }, context => {
            context.grant(itemId, 1)
            database.prepare("DELETE FROM players WHERE id = ?").run(playerId)
            context.flush()
        })
    ))(), /FOREIGN KEY constraint failed/)

    assert.notEqual(getPlayerSync(playerId), null)
    assert.equal(getPlayerItemSync(playerId, itemId), null)
    assert.equal(getCollectedRow(playerId, itemId), undefined)
})
