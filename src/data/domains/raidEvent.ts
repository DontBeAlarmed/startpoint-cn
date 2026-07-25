import { getDb } from "../db"

export interface PlayerRaidEvent {
    eventId: number
    totalKillCount: number
    receivedUpTo: number
}

export function getPlayerRaidEventSync(
    playerId: number,
    eventId: number,
): PlayerRaidEvent | null {
    const row = getDb().prepare(`
        SELECT event_id, total_kill_count, received_up_to
        FROM players_raid_events
        WHERE player_id = ? AND event_id = ?
    `).get(playerId, eventId) as {
        event_id: number
        total_kill_count: number
        received_up_to: number
    } | undefined
    if (!row) return null
    return {
        eventId: row.event_id,
        totalKillCount: row.total_kill_count,
        receivedUpTo: row.received_up_to,
    }
}

export function upsertPlayerRaidEventSync(
    playerId: number,
    eventId: number,
    totalKillCount: number,
    receivedUpTo: number,
): PlayerRaidEvent {
    getDb().prepare(`
        INSERT INTO players_raid_events (player_id, event_id, total_kill_count, received_up_to)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id, event_id) DO UPDATE SET
            total_kill_count = excluded.total_kill_count,
            received_up_to = excluded.received_up_to
    `).run(playerId, eventId, totalKillCount, receivedUpTo)
    return { eventId, totalKillCount, receivedUpTo }
}
