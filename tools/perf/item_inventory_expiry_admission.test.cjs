"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "item-inventory-expiry-admission-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("../helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const {
    productionContentSnapshotProvider,
} = require("../../src/content/runtime/content-snapshot")
const data = require("../../src/data")
const { insertAccountSync } = require("../../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
const { setPlayerItemForMaintenanceSync } = require("../../src/data/domains/item-maintenance")
const { parseItemInventoryPolicyCatalog } = require("../../src/lib/inventory/item-inventory-policy")
const { settleEventTradeExpiryOnLoadSync } = require("../../src/lib/event-trade-expiry-settlement")

const POLICY_TABLE = "item_inventory_policy.json"
const EXPIRY_NOW_MS = Number.MAX_SAFE_INTEGER
let database

function createPlayer(label, { freeMana = 0, paidMana = 0 } = {}) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `item-expiry-admission-${label}`,
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    updatePlayerSync({ id: player.id, freeMana, paidMana })
    return player.id
}

function installProductionPolicyLookupProbe() {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const rawCatalog = previousSnapshot.repository.table(POLICY_TABLE)
    const parsedCatalog = parseItemInventoryPolicyCatalog(rawCatalog)
    const counts = { tableLookups: 0, catalogParses: 0 }
    const observedRawCatalog = new Proxy(rawCatalog, {
        ownKeys(target) {
            counts.catalogParses++
            return Reflect.ownKeys(target)
        },
    })
    productionContentSnapshotProvider.snapshot = {
        ...previousSnapshot,
        repository: {
            info: () => previousSnapshot.repository.info(),
            table(tableName) {
                if (tableName === POLICY_TABLE) {
                    counts.tableLookups++
                    return observedRawCatalog
                }
                return previousSnapshot.repository.table(tableName)
            },
        },
    }
    return {
        counts,
        expiredItemIds: parsedCatalog.eventTradeItemIds.filter(itemId => (
            parsedCatalog.byItemId[String(itemId)].endTimeMs !== null
        )),
        restore() {
            productionContentSnapshotProvider.snapshot = previousSnapshot
        },
    }
}

function instrumentExpiryStatements() {
    const counts = {
        candidateReads: 0,
        playerReads: 0,
        itemWrites: 0,
        playerWrites: 0,
        transactions: 0,
    }
    const originalPrepare = database.prepare
    const originalTransaction = database.transaction
    function countExecution(sql) {
        if (/SELECT id, amount FROM players_items WHERE player_id = \?/i.test(sql)) {
            counts.candidateReads++
        } else if (/FROM players WHERE id = \?/i.test(sql)) {
            counts.playerReads++
        } else if (/UPDATE players_items SET amount = \?/i.test(sql)) {
            counts.itemWrites++
        } else if (/UPDATE players SET /i.test(sql)) {
            counts.playerWrites++
        }
    }
    database.prepare = function countedPrepare(statement) {
        const sql = String(statement).replace(/\s+/g, " ").trim()
        const prepared = originalPrepare.call(this, statement)
        let proxy
        proxy = new Proxy(prepared, {
            get(target, property) {
                const value = Reflect.get(target, property, target)
                if (typeof value !== "function") return value
                if (["all", "get", "iterate", "run"].includes(property)) {
                    return (...args) => {
                        countExecution(sql)
                        return Reflect.apply(value, target, args)
                    }
                }
                return (...args) => {
                    const result = Reflect.apply(value, target, args)
                    return result === target ? proxy : result
                }
            },
        })
        return proxy
    }
    database.transaction = (...args) => {
        counts.transactions++
        return originalTransaction.call(database, ...args)
    }
    return {
        counts,
        restore() {
            database.prepare = originalPrepare
            database.transaction = originalTransaction
        },
    }
}

function settle(playerId, player) {
    assert.ok(player)
    return settleEventTradeExpiryOnLoadSync({
        playerId,
        player,
        nowMs: EXPIRY_NOW_MS,
        maxMana: Number.MAX_SAFE_INTEGER,
    })
}

function measureSettlement(playerId) {
    const player = getPlayerSync(playerId)
    const probe = instrumentExpiryStatements()
    try {
        return { result: settle(playerId, player), counts: probe.counts }
    } finally {
        probe.restore()
    }
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

test("production expiry load keeps Content, SQL and transaction work bounded", () => {
    const policyProbe = installProductionPolicyLookupProbe()
    try {
        const batchIds = policyProbe.expiredItemIds.slice(0, 4)
        assert.equal(batchIds.length, 4, "bundled policy must provide four expiring EventTrade items")

        const noExpiryPlayer = createPlayer("none")
        const noExpiry = measureSettlement(noExpiryPlayer)
        assert.deepEqual(noExpiry.result, { status: "none" })
        assert.deepEqual(noExpiry.counts, {
            candidateReads: 1,
            playerReads: 0,
            itemWrites: 0,
            playerWrites: 0,
            transactions: 0,
        })

        const singlePlayer = createPlayer("single")
        setPlayerItemForMaintenanceSync(singlePlayer, batchIds[0], 3)
        const single = measureSettlement(singlePlayer)
        assert.equal(single.result.status, "converted")
        assert.deepEqual(single.counts, {
            candidateReads: 1,
            playerReads: 2,
            itemWrites: 1,
            playerWrites: 1,
            transactions: 1,
        })

        const batchPlayer = createPlayer("batch")
        for (const [index, itemId] of batchIds.entries()) {
            setPlayerItemForMaintenanceSync(batchPlayer, itemId, index + 1)
        }
        const batch = measureSettlement(batchPlayer)
        assert.equal(batch.result.status, "converted")
        assert.deepEqual(batch.counts, {
            candidateReads: 1,
            playerReads: 2,
            itemWrites: batchIds.length,
            playerWrites: 1,
            transactions: 1,
        })

        assert.deepEqual(policyProbe.counts, {
            tableLookups: 3,
            catalogParses: 1,
        })
    } finally {
        policyProbe.restore()
    }
})
