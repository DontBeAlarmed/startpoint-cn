import { getDb } from "../db"

export interface ActiveMissionCounters {
    totalUsedManaCount: number
    totalGachaCharacterCount: number
}

export function getActiveMissionCountersSync(playerId: number): ActiveMissionCounters {
    const row = getDb().prepare(`
        SELECT total_used_mana_count, total_gacha_character_count
        FROM players_active_mission_counters
        WHERE player_id = ?
    `).get(playerId) as {
        total_used_mana_count: number
        total_gacha_character_count: number
    } | undefined
    return {
        totalUsedManaCount: Math.max(0, row?.total_used_mana_count ?? 0),
        totalGachaCharacterCount: Math.max(0, row?.total_gacha_character_count ?? 0),
    }
}

export function incrementActiveMissionUsedManaCountSync(playerId: number, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (player_id, total_used_mana_count)
        VALUES (?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            total_used_mana_count = total_used_mana_count + excluded.total_used_mana_count
    `).run(playerId, amount)
}

export function incrementActiveMissionGachaCharacterCountSync(playerId: number, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_counters (player_id, total_gacha_character_count)
        VALUES (?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            total_gacha_character_count = total_gacha_character_count + excluded.total_gacha_character_count
    `).run(playerId, amount)
}
