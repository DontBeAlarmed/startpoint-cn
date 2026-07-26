import { getDb } from "../db"

export interface RaidEventBossState {
    weightedKillCount: number
    totalKillCount: number
}

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

export function getRaidEventBossStateSync(eventId: number): RaidEventBossState | null {
    const row = getDb().prepare(`
        SELECT weighted_kill_count, total_kill_count
        FROM raid_event_boss_states
        WHERE event_id = ?
    `).get(eventId) as {
        weighted_kill_count: number
        total_kill_count: number
    } | undefined
    return row ? {
        weightedKillCount: row.weighted_kill_count,
        totalKillCount: row.total_kill_count,
    } : null
}

export function upsertRaidEventBossStateSync(
    eventId: number,
    state: RaidEventBossState,
): RaidEventBossState {
    getDb().prepare(`
        INSERT INTO raid_event_boss_states (event_id, weighted_kill_count, total_kill_count)
        VALUES (?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
            weighted_kill_count = excluded.weighted_kill_count,
            total_kill_count = excluded.total_kill_count
    `).run(eventId, state.weightedKillCount, state.totalKillCount)
    return state
}

export function incrementPlayerRaidEventQuestKillCountSync(
    playerId: number,
    eventId: number,
    questId: number,
): number {
    const row = getDb().prepare(`
        INSERT INTO players_raid_event_quests (player_id, event_id, quest_id, kill_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(player_id, event_id, quest_id) DO UPDATE SET
            kill_count = kill_count + 1
        RETURNING kill_count
    `).get(playerId, eventId, questId) as { kill_count: number }
    return row.kill_count
}

export function getPlayerRaidEventQuestCountsSync(
    playerId: number,
    eventId: number,
): Record<number, number> {
    const rows = getDb().prepare(`
        SELECT quest_id, kill_count
        FROM players_raid_event_quests
        WHERE player_id = ? AND event_id = ?
        ORDER BY quest_id
    `).all(playerId, eventId) as { quest_id: number, kill_count: number }[]
    return Object.fromEntries(rows.map(row => [row.quest_id, row.kill_count]))
}
