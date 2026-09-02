"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reward-grant-typed-failures-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { setPlayerItemForMaintenanceSync } = require("../src/data/domains/item-maintenance")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { givePlayerCharacterSync } = require("../src/lib/character")
const {
    RewardGrantContractValidationError,
    RewardGrantExecutionTransactionError,
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    executeRewardGrantExecutionPlanSync,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
} = require("../src/lib/reward-grant")
const {
    withDeferredInventoryBatchContextWithinTransactionSync,
} = require("../src/lib/inventory")
const { PlayerResourceGrantError } = require("../src/lib/player-resource-grant")
const { RewardType } = require("../src/lib/types/rewards")

const COST_ITEM_ID = 931001
const OTHER_ITEM_ID = 931002
const EQUIPMENT_ID = 3010006
const DUPLICATE_CHARACTER_ID = 1
const COMPENSATION_ITEM_ID = 14002

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function knownPlayer(playerId, overrides = {}) {
    const player = getPlayerSync(playerId)
    assert.ok(player)
    return {
        playerId,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
        ...overrides,
    }
}

test.before(() => {
    data.initializeDatabase()
    getDb().exec("CREATE TABLE reward_grant_source_sentinel (value INTEGER NOT NULL)")
    getDb().exec("CREATE TABLE reward_grant_write_order (kind TEXT NOT NULL)")
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("external source explicitly finalizes cost and reward before later source writes", () => {
    const playerId = createPlayer("external-finalize")
    setPlayerItemForMaintenanceSync(playerId, COST_ITEM_ID, 5)
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: COST_ITEM_ID, count: 3 },
    ])

    const result = getDb().transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: [COST_ITEM_ID],
        playerExistence: "caller-verified",
    }, inventory => {
        inventory.deduct(COST_ITEM_ID, 2)
        return withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
            playerId,
            plan,
            knownPlayer(playerId),
            inventory,
            execution => {
                const checked = snapshotRewardGrantExecutionResultForPlan(
                    playerId,
                    plan,
                    execution.result,
                )
                assert.equal(checked.entries[0].outcome.item.beforeAmount, 3)
                assert.equal(checked.entries[0].outcome.item.afterAmount, 6)
                const finalized = execution.finalize()
                getDb().prepare("INSERT INTO reward_grant_source_sentinel (value) VALUES (1)").run()
                return finalized
            },
        )
    }))()

    assert.equal(result.assets.items[0].afterAmount, 6)
    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 6)
    assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM reward_grant_source_sentinel").get().count, 1)
})

test("external source fails closed when finalize is omitted or Inventory changes after grant", () => {
    const playerId = createPlayer("external-missing-finalize")
    setPlayerItemForMaintenanceSync(playerId, COST_ITEM_ID, 5)
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: COST_ITEM_ID, count: 2 },
    ])

    assert.throws(() => getDb().transaction(() => (
        withDeferredInventoryBatchContextWithinTransactionSync({ playerId }, inventory => {
            inventory.deduct(COST_ITEM_ID, 1)
            return withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                playerId,
                plan,
                knownPlayer(playerId),
                inventory,
                () => "forgot finalize",
            )
        })
    ))(), error => error instanceof RewardGrantExecutionTransactionError
        && error.reason === "FINALIZATION_REQUIRED")
    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 5)

    assert.throws(() => getDb().transaction(() => (
        withDeferredInventoryBatchContextWithinTransactionSync({ playerId }, inventory => (
            withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                playerId,
                plan,
                knownPlayer(playerId),
                inventory,
                execution => {
                    inventory.grant(OTHER_ITEM_ID, 1)
                    execution.finalize()
                },
            )
        ))
    ))(), error => error instanceof RewardGrantExecutionTransactionError
        && error.reason === "INVENTORY_CHANGED_AFTER_GRANT")
    assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 5)
    assert.equal(getPlayerItemSync(playerId, OTHER_ITEM_ID), null)

    for (const mutate of [
        inventory => {
            inventory.deduct(COST_ITEM_ID, 1)
            inventory.restore(COST_ITEM_ID, 1)
        },
        inventory => inventory.grant(COST_ITEM_ID, 0),
    ]) {
        assert.throws(() => getDb().transaction(() => (
            withDeferredInventoryBatchContextWithinTransactionSync({ playerId }, inventory => (
                withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                    playerId,
                    plan,
                    knownPlayer(playerId),
                    inventory,
                    execution => {
                        mutate(inventory)
                        execution.finalize()
                    },
                )
            ))
        ))(), error => error instanceof RewardGrantExecutionTransactionError
            && error.reason === "INVENTORY_CHANGED_AFTER_GRANT")
        assert.equal(getPlayerItemSync(playerId, COST_ITEM_ID), 5)
    }
})

test("external Inventory capability must belong to the RewardGrant player", () => {
    const inventoryPlayerId = createPlayer("external-context-owner")
    const targetPlayerId = createPlayer("external-context-target")
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: OTHER_ITEM_ID, count: 2 },
    ])

    assert.throws(() => getDb().transaction(() => (
        withDeferredInventoryBatchContextWithinTransactionSync({
            playerId: inventoryPlayerId,
        }, inventory => withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
            targetPlayerId,
            plan,
            knownPlayer(targetPlayerId),
            inventory,
            execution => execution.finalize(),
        ))
    ))(), error => error instanceof RewardGrantExecutionTransactionError
        && error.reason === "INVENTORY_PLAYER_MISMATCH")
    assert.equal(getPlayerItemSync(inventoryPlayerId, OTHER_ITEM_ID), null)
    assert.equal(getPlayerItemSync(targetPlayerId, OTHER_ITEM_ID), null)
})

test("external finalize writes Inventory before Player resources and late source failure rolls both back", t => {
    const playerId = createPlayer("external-order")
    const itemId = OTHER_ITEM_ID + 10
    const before = knownPlayer(playerId)
    const itemTrigger = "record_reward_grant_item_order"
    const playerTrigger = "record_reward_grant_player_order"
    getDb().exec(`
        CREATE TRIGGER ${itemTrigger}
        AFTER INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${itemId}
        BEGIN INSERT INTO reward_grant_write_order (kind) VALUES ('item'); END;
        CREATE TRIGGER ${playerTrigger}
        AFTER UPDATE OF free_mana ON players
        WHEN NEW.id = ${playerId}
        BEGIN INSERT INTO reward_grant_write_order (kind) VALUES ('player'); END;
    `)
    t.after(() => getDb().exec(`
        DROP TRIGGER IF EXISTS ${itemTrigger};
        DROP TRIGGER IF EXISTS ${playerTrigger};
    `))
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: itemId, count: 2 },
        { type: RewardType.MANA, count: 3 },
    ])

    getDb().transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
    }, inventory => withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
        playerId,
        plan,
        knownPlayer(playerId),
        inventory,
        execution => {
            execution.finalize()
            assert.throws(
                () => execution.finalize(),
                error => error instanceof RewardGrantExecutionTransactionError
                    && error.reason === "ALREADY_FINALIZED",
            )
            getDb().prepare("INSERT INTO reward_grant_source_sentinel (value) VALUES (2)").run()
        },
    )))()
    assert.deepEqual(
        getDb().prepare("SELECT kind FROM reward_grant_write_order ORDER BY rowid").all()
            .map(row => row.kind),
        ["item", "player"],
    )

    getDb().prepare("DELETE FROM reward_grant_write_order").run()
    const committedItem = getPlayerItemSync(playerId, itemId)
    const committedPlayer = getPlayerSync(playerId)
    assert.throws(() => getDb().transaction(() => (
        withDeferredInventoryBatchContextWithinTransactionSync({ playerId }, inventory => (
            withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
                playerId,
                plan,
                knownPlayer(playerId),
                inventory,
                execution => {
                    execution.finalize()
                    throw new Error("late source failure after finalize")
                },
            )
        ))
    ))(), /late source failure after finalize/)
    assert.equal(getPlayerItemSync(playerId, itemId), committedItem)
    assert.deepEqual(getPlayerSync(playerId), committedPlayer)
    assert.deepEqual(getDb().prepare("SELECT kind FROM reward_grant_write_order").all(), [])
    assert.equal(getPlayerSync(playerId).freeMana, before.freeMana + 3)
})

test("late Equipment failure rolls earlier Item grant back", () => {
    const playerId = createPlayer("equipment-failure")
    const trigger = "reject_typed_reward_equipment"
    getDb().exec(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT ON players_equipment
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${EQUIPMENT_ID}
        BEGIN SELECT RAISE(ABORT, 'forced Equipment failure'); END;
    `)
    try {
        assert.throws(() => executeRewardGrantExecutionPlanSync(
            playerId,
            createRewardGrantExecutionPlan([
                { type: RewardType.ITEM, id: OTHER_ITEM_ID, count: 2 },
                { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
            ]),
        ), /forced Equipment failure/)
    } finally {
        getDb().exec(`DROP TRIGGER ${trigger}`)
    }
    assert.equal(getPlayerItemSync(playerId, OTHER_ITEM_ID), null)
    assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_ID), null)
})

test("duplicate Character compensation flush failure rolls stack and Item back", () => {
    const playerId = createPlayer("compensation-failure")
    if (getPlayerCharacterSync(playerId, DUPLICATE_CHARACTER_ID) === null) {
        givePlayerCharacterSync(playerId, DUPLICATE_CHARACTER_ID)
    }
    const beforeStack = getPlayerCharacterSync(playerId, DUPLICATE_CHARACTER_ID).stack
    const trigger = "reject_typed_reward_compensation"
    getDb().exec(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${COMPENSATION_ITEM_ID}
        BEGIN SELECT RAISE(ABORT, 'forced compensation failure'); END;
    `)
    try {
        assert.throws(() => executeRewardGrantExecutionPlanSync(
            playerId,
            createRewardGrantExecutionPlan([
                { type: RewardType.CHARACTER, id: DUPLICATE_CHARACTER_ID },
            ]),
        ), /forced compensation failure/)
    } finally {
        getDb().exec(`DROP TRIGGER ${trigger}`)
    }
    assert.equal(getPlayerCharacterSync(playerId, DUPLICATE_CHARACTER_ID).stack, beforeStack)
    assert.equal(getPlayerItemSync(playerId, COMPENSATION_ITEM_ID), null)
})

test("transaction-owner rejects stale Player resource state without partial update", () => {
    const playerId = createPlayer("stale-resource")
    const before = knownPlayer(playerId)
    assert.throws(() => getDb().transaction(() => {
        updatePlayerSync({ id: playerId, freeMana: before.freeMana + 1 })
        executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            playerId,
            createRewardGrantExecutionPlan([{ type: RewardType.MANA, count: 2 }]),
            before,
        )
    })(), error => error instanceof PlayerResourceGrantError
        && error.field === "totalManaObtained")
    assert.equal(getPlayerSync(playerId).freeMana, before.freeMana)
})

test("typed execution normalizes forged plan containers before any write", () => {
    const playerId = createPlayer("forged-plan")
    const before = getPlayerSync(playerId)
    for (const forged of [null, {}, { entries: Array(1) }]) {
        assert.throws(
            () => executeRewardGrantExecutionPlanSync(playerId, forged),
            RewardGrantContractValidationError,
        )
    }
    assert.deepEqual(getPlayerSync(playerId), before)
})
