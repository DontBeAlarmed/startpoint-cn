// Periodic snapshot — stores counter baselines for daily/weekly mission reset

import { getDb } from "../../data/db"

export interface SnapshotData {
    questClears: number
    staminaUsed: number
    rankSs: number
    rankS: number
    rankA: number
    rankB: number
}

export function takeSnapshot(playerId: number, periodType: 'daily' | 'weekly', data: SnapshotData): void {
    getDb().prepare(`
    INSERT OR REPLACE INTO players_periodic_snapshots
        (player_id, period_type, quest_clears, stamina_used, rank_ss, rank_s, rank_a, rank_b, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(playerId, periodType, data.questClears, data.staminaUsed, data.rankSs, data.rankS, data.rankA, data.rankB)
}

export function getSnapshot(playerId: number, periodType: 'daily' | 'weekly'): SnapshotData | null {
    const row = getDb().prepare(`
    SELECT quest_clears, stamina_used, rank_ss, rank_s, rank_a, rank_b
    FROM players_periodic_snapshots
    WHERE player_id = ? AND period_type = ?
    `).get(playerId, periodType) as Record<string, number> | undefined
    if (!row) return null
    return {
        questClears: row.quest_clears,
        staminaUsed: row.stamina_used,
        rankSs: row.rank_ss,
        rankS: row.rank_s,
        rankA: row.rank_a,
        rankB: row.rank_b,
    }
}
