"use strict"

require("ts-node/register/transpile-only")

const { getDb } = require("../../src/data/db")
const { setPlayerItemForMaintenanceSync } = require("../../src/data/domains/item-maintenance")
const {
    grantInventoryItemSync,
    grantInventoryItemWithinTransactionSync,
} = require("../../src/lib/inventory")

/**
 * Models an Item newly obtained by a test player. This updates both current
 * inventory and the collected total, while preserving an existing caller's
 * transaction ownership.
 */
function grantInventoryFixtureItemSync(playerId, itemId, amount) {
    const grant = getDb().inTransaction
        ? grantInventoryItemWithinTransactionSync
        : grantInventoryItemSync
    return grant({ playerId, itemId: Number(itemId), amount }).afterAmount
}

/**
 * Constructs authoritative fixture state. Exact state setup is not an Item
 * acquisition and therefore must not change the collected total.
 */
function setInventoryFixtureItemExactSync(playerId, itemId, amount) {
    setPlayerItemForMaintenanceSync(playerId, itemId, amount)
}

module.exports = {
    grantInventoryFixtureItemSync,
    setInventoryFixtureItemExactSync,
}
