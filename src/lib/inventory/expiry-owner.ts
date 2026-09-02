import { getDb } from "../../data/db"
import { InventoryTransactionError, InventoryValidationError } from "./errors"
import { InventorySqliteRepository } from "./sqlite-repository"

export interface InventoryExpiryItem {
    readonly itemId: number
    readonly amount: number
}

function normalizeItems(items: readonly InventoryExpiryItem[]): InventoryExpiryItem[] {
    if (!Array.isArray(items)) throw new TypeError("expiry items must be an array")
    const seen = new Set<number>()
    return [...items]
        .map(item => {
            if (!item || typeof item !== "object") {
                throw new TypeError("expiry item must be an object")
            }
            if (!Number.isSafeInteger(item.itemId) || item.itemId <= 0) {
                throw new InventoryValidationError(
                    "INVALID_ITEM_ID",
                    "expiry itemId must be a positive safe integer",
                )
            }
            if (!Number.isSafeInteger(item.amount) || item.amount <= 0) {
                throw new InventoryValidationError(
                    "INVALID_AMOUNT",
                    `expiry amount for item ${item.itemId} must be a positive safe integer`,
                )
            }
            if (seen.has(item.itemId)) {
                throw new InventoryValidationError(
                    "INVALID_STORED_STATE",
                    `duplicate expiry item ${item.itemId}`,
                )
            }
            seen.add(item.itemId)
            return { itemId: item.itemId, amount: item.amount }
        })
        .sort((left, right) => left.itemId - right.itemId)
}

/**
 * Clears already-read expired Item rows while preserving the caller's transaction.
 * The expected amount guard prevents a stale load snapshot from silently clearing a
 * changed row. Expiry is not a new acquisition, so no collected-total row is written.
 */
export function expireInventoryItemsWithinTransactionSync(
    playerId: number,
    items: readonly InventoryExpiryItem[],
) {
    if (!getDb().inTransaction) {
        throw new InventoryTransactionError(
            "TRANSACTION_REQUIRED",
            "inventory expiry requires an active transaction",
        )
    }
    const normalized = normalizeItems(items)
    if (normalized.length === 0) return Object.freeze([])

    const repository = new InventorySqliteRepository()
    repository.requirePlayerSync(playerId)
    const results = normalized.map(item => {
        repository.writeExpectedItemSync(playerId, item.itemId, item.amount, 0)
        return Object.freeze({
            itemId: item.itemId,
            beforeAmount: item.amount,
            afterAmount: 0,
            obtainedAmount: 0,
        })
    })
    return Object.freeze(results)
}
