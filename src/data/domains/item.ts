import { getDb } from "../db";
import { RawPlayerItem } from "../types";

/**
 * Gets the amount of a singular item that a player owns.
 * 
 * @param playerId The ID of the player.
 * @param itemId The ID of the item.
 * @returns The amount of the item that the player owns, or null, indicating no ownership.
 */
export function getPlayerItemSync(
    playerId: number,
    itemId: number | string
): number | null {
    const db = getDb();
    const rawItem = db.prepare(`
    SELECT id, amount
    FROM players_items
    WHERE player_id = ? AND id = ?
    `).get(playerId, Number(itemId)) as RawPlayerItem | undefined

    return rawItem === undefined ? null : rawItem.amount
}

/**
 * Gets the items that a player owns.
 * 
 * @param playerId The ID of the player.
 * @returns A record where the index is the item's ID and the value is the item's amount.
 */
export function getPlayerItemsSync(
    playerId: number
): Record<string, number> {
    const db = getDb();
    const rawItems = db.prepare(`
    SELECT id, amount
    FROM players_items
    WHERE player_id = ?
    `).all(playerId) as RawPlayerItem[]

    const output: Record<string, number> = {}
    for (const rawItem of rawItems) {
        output[rawItem.id.toString()] = rawItem.amount
    }

    return output
}

export function getPlayerCollectedItemTotalSync(
    playerId: number,
    itemId: number | string
): number {
    const row = getDb().prepare(`
    SELECT total_obtained
    FROM players_collected_items
    WHERE player_id = ? AND item_id = ?
    `).get(playerId, Number(itemId)) as { total_obtained: number } | undefined
    return row?.total_obtained ?? 0
}

export function getPlayerCollectedItemTotalsSync(
    playerId: number
): Record<string, number> {
    const rows = getDb().prepare(`
    SELECT item_id, total_obtained
    FROM players_collected_items
    WHERE player_id = ?
    `).all(playerId) as { item_id: number; total_obtained: number }[]
    return Object.fromEntries(rows.map(row => [String(row.item_id), row.total_obtained]))
}

function recordPlayerCollectedItemSync(
    playerId: number,
    itemId: number | string,
    obtainedAmount: number
): void {
    if (!Number.isSafeInteger(obtainedAmount) || obtainedAmount <= 0) return
    getDb().prepare(`
    INSERT INTO players_collected_items (player_id, item_id, total_obtained)
    VALUES (?, ?, ?)
    ON CONFLICT(player_id, item_id) DO UPDATE SET
        total_obtained = total_obtained + excluded.total_obtained
    `).run(playerId, Number(itemId), obtainedAmount)
}

/**
 * Inserts a singular item into the player's inventory.
 * 
 * @param playerId The ID of the player.
 * @param itemId The ID of the item to insert.
 * @param amount The amount of the item to insert.
 */
function insertPlayerItemSync(
    playerId: number,
    itemId: number | string,
    amount: number
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_items (id, amount, player_id)
    VALUES (?, ?, ?)
    `).run(Number(itemId), amount, playerId)
}

/**
 * Batch inserts a record of player items into a player's inventory.
 * 
 * @param playerId The ID of the player.
 * @param items The record of items.
 */
export function insertPlayerItemsSync(
    playerId: number,
    items: Record<string, number>
) {
    const db = getDb();
    db.transaction(() => {
        for (const [itemId, amount] of Object.entries(items)) {
            insertPlayerItemSync(playerId, itemId, amount)
        }
    })()
}

/**
 * Updates a player's item's amount.
 * 
 * @param playerId The ID of the player.
 * @param itemId The item's ID.
 * @param amount The new amount the item should have.
 */
export function updatePlayerItemSync(
    playerId: number,
    itemId: string | number,
    amount: number
) {
    const db = getDb();
    db.prepare(`
    UPDATE players_items
    SET amount = ?
    WHERE player_id = ? AND id = ?
    `).run(amount, playerId, Number(itemId))
}

/**
 * Sets a player's item to an exact amount, inserting the row first if the player does not yet
 * own the item.
 *
 * updatePlayerItemSync on its own is a bare UPDATE that silently affects zero rows when the
 * player does not already own the item, so callers that mean "add or set this item" (e.g. the
 * web admin's POST /:id/item) would return success while writing nothing for a not-yet-owned item.
 *
 * @param playerId The ID of the player.
 * @param itemId The item's ID.
 * @param amount The exact amount the item should have.
 */
export function setPlayerItemSync(
    playerId: number,
    itemId: string | number,
    amount: number
) {
    if (getPlayerItemSync(playerId, itemId) === null) {
        insertPlayerItemSync(playerId, itemId, amount)
    } else {
        updatePlayerItemSync(playerId, itemId, amount)
    }
}

/**
 * Gives a player giveAmount of an item.
 * 
 * @param playerId The ID of the player.
 * @param itemId The ID of the item.
 * @param giveAmount The amount of the item to give.
 * @returns The new total amount of the item that the player owns.
 */
export function givePlayerItemSync(
    playerId: number,
    itemId: string | number,
    giveAmount: number
): number {
    return getDb().transaction(() => (
        givePlayerItemWithinTransactionSync(playerId, itemId, giveAmount)
    ))()
}

/**
 * Gives an item while the caller owns the surrounding database transaction.
 * Keep the transaction boundary in givePlayerItemSync for ordinary callers.
 */
export function givePlayerItemWithinTransactionSync(
    playerId: number,
    itemId: string | number,
    giveAmount: number,
): number {
    if (!getDb().inTransaction) {
        throw new Error("givePlayerItemWithinTransactionSync requires an active caller transaction")
    }
    const ownedAmount = getPlayerItemSync(playerId, itemId)
    const newAmount = (ownedAmount ?? 0) + giveAmount
    if (ownedAmount === null) insertPlayerItemSync(playerId, itemId, newAmount)
    else updatePlayerItemSync(playerId, itemId, newAmount)
    recordPlayerCollectedItemSync(playerId, itemId, giveAmount)
    return newAmount
}
