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

export function getPlayerItemsByIdsSync(
    playerId: number,
    itemIds: readonly number[],
): Record<string, number> {
    const ids = [...new Set(itemIds)]
        .filter(itemId => Number.isSafeInteger(itemId) && itemId > 0)
    if (ids.length === 0) return {}
    const placeholders = ids.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT id, amount
        FROM players_items
        WHERE player_id = ? AND id IN (${placeholders})
    `).all(playerId, ...ids) as RawPlayerItem[]
    return Object.fromEntries(rows.map(row => [String(row.id), row.amount]))
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

export function getPlayerCollectedItemTotalsByIdsSync(
    playerId: number,
    itemIds: readonly number[],
): Record<string, number> {
    const normalizedIds = [...new Set(itemIds)]
        .filter(itemId => Number.isSafeInteger(itemId) && itemId > 0)
    if (normalizedIds.length === 0) return {}
    const placeholders = normalizedIds.map(() => "?").join(", ")
    const rows = getDb().prepare(`
    SELECT item_id, total_obtained
    FROM players_collected_items
    WHERE player_id = ? AND item_id IN (${placeholders})
    `).all(playerId, ...normalizedIds) as { item_id: number; total_obtained: number }[]
    return Object.fromEntries(rows.map(row => [String(row.item_id), row.total_obtained]))
}
