import { getDb } from "../db"

function deliveryKey(newsId: number): string {
    if (!Number.isSafeInteger(newsId) || newsId <= 0) {
        throw new TypeError("newsId must be a positive safe integer")
    }
    return `server.forced_news.${newsId}`
}

export function hasForcedNewsDeliverySync(playerId: number, newsId: number): boolean {
    const row = getDb().prepare(`
        SELECT 1
        FROM players_options
        WHERE player_id = ? AND key = ?
        LIMIT 1
    `).get(playerId, deliveryKey(newsId))
    return row !== undefined
}

export function claimForcedNewsDeliverySync(
    playerId: number,
    newsId: number,
): boolean {
    const result = getDb().prepare(`
        INSERT OR IGNORE INTO players_options (key, value, player_id)
        VALUES (?, 1, ?)
    `).run(deliveryKey(newsId), playerId)
    return result.changes === 1
}
