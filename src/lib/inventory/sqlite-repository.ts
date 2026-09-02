import { getDb } from "../../data/db"
import {
    InventoryTransactionError,
    InventoryValidationError,
} from "./errors"

export interface InventoryStoredItem {
    readonly itemId: number
    readonly amount: number
    readonly rowExists: boolean
}

interface RawInventoryItemRow {
    readonly id: number
    readonly amount: number
}

interface RawCollectedItemState {
    readonly total_obtained: number
    readonly storage_type: string
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

function requireActiveTransaction(): void {
    if (!getDb().inTransaction) {
        throw new InventoryTransactionError(
            "TRANSACTION_REQUIRED",
            "inventory repository requires an active transaction",
        )
    }
}

function positiveId(value: unknown, reason: "INVALID_PLAYER_ID" | "INVALID_ITEM_ID", field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new InventoryValidationError(reason, `${field} must be a positive safe integer`)
    }
    return value
}

function nonNegativeAmount(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new InventoryValidationError(
            "INVALID_STORED_STATE",
            `${field} must be a non-negative safe integer`,
        )
    }
    return value
}

function normalizeItemIds(itemIds: readonly number[]): number[] {
    const normalized = [...new Set(itemIds.map(itemId => (
        positiveId(itemId, "INVALID_ITEM_ID", "itemId")
    )))]
    return normalized.sort((left, right) => left - right)
}

function storedItem(itemId: number, row: RawInventoryItemRow | undefined): InventoryStoredItem {
    if (row === undefined) return { itemId, amount: 0, rowExists: false }
    if (row.id !== itemId) {
        throw new InventoryValidationError(
            "INVALID_STORED_STATE",
            `inventory repository returned the wrong item row for ${itemId}`,
        )
    }
    return {
        itemId,
        amount: nonNegativeAmount(row.amount, `stored item ${itemId} amount`),
        rowExists: true,
    }
}

/** Concrete WDFP SQLite persistence used only by the Inventory owner. */
export class InventorySqliteRepository {
    requirePlayerSync(playerId: number): void {
        requireActiveTransaction()
        const id = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const row = getDb().prepare("SELECT id FROM players WHERE id = ?").get(id) as { id: number } | undefined
        if (row === undefined || row.id !== id) {
            throw new InventoryValidationError(
                "INVALID_STORED_STATE",
                `inventory player ${id} does not exist`,
            )
        }
    }

    readItemSync(playerId: number, itemId: number): InventoryStoredItem {
        requireActiveTransaction()
        const ownerId = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const id = positiveId(itemId, "INVALID_ITEM_ID", "itemId")
        const row = getDb().prepare(`
            SELECT id, amount
            FROM players_items
            WHERE player_id = ? AND id = ?
        `).get(ownerId, id) as RawInventoryItemRow | undefined
        return storedItem(id, row)
    }

    readItemsByIdsSync(
        playerId: number,
        itemIds: readonly number[],
    ): ReadonlyMap<number, InventoryStoredItem> {
        requireActiveTransaction()
        const ownerId = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const ids = normalizeItemIds(itemIds)
        if (ids.length === 0) return new Map()
        const placeholders = ids.map(() => "?").join(", ")
        const rows = getDb().prepare(`
            SELECT id, amount
            FROM players_items
            WHERE player_id = ? AND id IN (${placeholders})
            ORDER BY id
        `).all(ownerId, ...ids) as RawInventoryItemRow[]
        const byId = new Map(rows.map(row => [
            positiveId(row.id, "INVALID_ITEM_ID", "stored item id"),
            row,
        ]))
        return new Map(ids.map(itemId => [itemId, storedItem(itemId, byId.get(itemId))]))
    }

    writeAbsoluteItemSync(playerId: number, itemId: number, amount: number): void {
        requireActiveTransaction()
        const ownerId = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const id = positiveId(itemId, "INVALID_ITEM_ID", "itemId")
        const afterAmount = nonNegativeAmount(amount, `item ${id} afterAmount`)
        const result = getDb().prepare(`
            INSERT INTO players_items (id, amount, player_id)
            VALUES (?, ?, ?)
            ON CONFLICT(id, player_id) DO UPDATE SET
                amount = excluded.amount
        `).run(id, afterAmount, ownerId)
        if (result.changes !== 1) {
            throw new Error(`inventory absolute write affected ${result.changes} rows`)
        }
    }

    writeExpectedItemSync(
        playerId: number,
        itemId: number,
        expectedAmount: number,
        afterAmount: number,
    ): void {
        requireActiveTransaction()
        const ownerId = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const id = positiveId(itemId, "INVALID_ITEM_ID", "itemId")
        const beforeAmount = nonNegativeAmount(expectedAmount, `item ${id} expectedAmount`)
        const nextAmount = nonNegativeAmount(afterAmount, `item ${id} afterAmount`)
        const result = getDb().prepare(`
            UPDATE players_items
            SET amount = ?
            WHERE player_id = ? AND id = ? AND amount = ?
        `).run(nextAmount, ownerId, id, beforeAmount)
        if (result.changes !== 1) {
            throw new InventoryValidationError(
                "INVALID_STORED_STATE",
                `inventory item ${id} changed before its expected write`,
            )
        }
    }

    recordPositiveObtainedSync(playerId: number, itemId: number, obtainedAmount: number): void {
        requireActiveTransaction()
        const ownerId = positiveId(playerId, "INVALID_PLAYER_ID", "playerId")
        const id = positiveId(itemId, "INVALID_ITEM_ID", "itemId")
        if (!Number.isSafeInteger(obtainedAmount) || obtainedAmount <= 0) {
            throw new InventoryValidationError(
                "INVALID_AMOUNT",
                "obtainedAmount must be a positive safe integer",
            )
        }
        const result = getDb().prepare(`
            INSERT INTO players_collected_items (player_id, item_id, total_obtained)
            VALUES (?, ?, ?)
            ON CONFLICT(player_id, item_id) DO UPDATE SET
                total_obtained = total_obtained + excluded.total_obtained
            WHERE typeof(players_collected_items.total_obtained) = 'integer'
              AND total_obtained >= 0
              AND total_obtained <= ? - excluded.total_obtained
        `).run(ownerId, id, obtainedAmount, MAX_SAFE_INTEGER)
        if (result.changes !== 1) {
            const stored = getDb().prepare(`
                SELECT total_obtained, typeof(total_obtained) AS storage_type
                FROM players_collected_items
                WHERE player_id = ? AND item_id = ?
            `).get(ownerId, id) as RawCollectedItemState | undefined
            if (stored !== undefined && (
                stored.storage_type !== "integer"
                || !Number.isSafeInteger(stored.total_obtained)
                || stored.total_obtained < 0
            )) {
                throw new InventoryValidationError(
                    "INVALID_STORED_STATE",
                    `collected total for item ${id} is not a non-negative safe SQLite integer`,
                )
            }
            throw new InventoryValidationError(
                "SAFE_INTEGER_OVERFLOW",
                `collected total for item ${id} is invalid or exceeds the safe integer range`,
            )
        }
    }
}
