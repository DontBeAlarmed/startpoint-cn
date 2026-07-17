import { Database as BetterSqlite3Database } from "better-sqlite3"

export function getClaimedCarnivalRewardIdsSync(
    db: BetterSqlite3Database,
    playerId: number,
    eventId: number,
): Set<number> {
    const rows = db.prepare(`
    SELECT reward_id
    FROM players_carnival_event_rewards
    WHERE player_id = ? AND event_id = ?
    `).all(playerId, eventId) as { reward_id: number }[]
    return new Set(rows.map(row => row.reward_id))
}

export function insertClaimedCarnivalRewardIdsSync(
    db: BetterSqlite3Database,
    playerId: number,
    eventId: number,
    rewardIds: number[],
) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO players_carnival_event_rewards (player_id, event_id, reward_id)
    VALUES (?, ?, ?)
    `)
    for (const rewardId of rewardIds) insert.run(playerId, eventId, rewardId)
}

export function givePlayerDegreeSync(
    db: BetterSqlite3Database,
    playerId: number,
    degreeId: number,
): boolean {
    const result = db.prepare(`
    INSERT OR IGNORE INTO players_degrees (player_id, degree_id)
    VALUES (?, ?)
    `).run(playerId, degreeId)
    return result.changes > 0
}

export function getPlayerDegreeIdsSync(
    db: BetterSqlite3Database,
    playerId: number,
): number[] {
    const rows = db.prepare(`
    SELECT degree_id
    FROM players_degrees
    WHERE player_id = ?
    ORDER BY degree_id
    `).all(playerId) as { degree_id: number }[]
    return rows.map(row => row.degree_id)
}
