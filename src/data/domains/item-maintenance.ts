import { getDb } from "../db"

/**
 * Writes the exact Item state requested by an operator. This intentionally
 * bypasses gameplay grant policy and does not change collected-item totals.
 */
export function setPlayerItemForMaintenanceSync(
    playerId: number,
    itemId: number | string,
    amount: number,
): void {
    getDb().prepare(`
        INSERT INTO players_items (id, amount, player_id)
        VALUES (?, ?, ?)
        ON CONFLICT(id, player_id) DO UPDATE SET
            amount = excluded.amount
    `).run(Number(itemId), amount, playerId)
}

/** Removes one exact Item row as an explicit operator action. */
export function deletePlayerItemForMaintenanceSync(
    playerId: number,
    itemId: number | string,
): void {
    getDb().prepare(`
        DELETE FROM players_items
        WHERE player_id = ? AND id = ?
    `).run(playerId, Number(itemId))
}

/**
 * Imports authoritative legacy-save Item rows inside the replace operation's
 * existing transaction. Imported amounts are state, not newly obtained Items.
 */
export function insertPlayerItemsForRestoreImportSync(
    playerId: number,
    items: Record<string, number>,
): void {
    const insert = getDb().prepare(`
        INSERT INTO players_items (id, amount, player_id)
        VALUES (?, ?, ?)
    `)
    for (const [itemId, amount] of Object.entries(items)) {
        insert.run(Number(itemId), amount, playerId)
    }
}
