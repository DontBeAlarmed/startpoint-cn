import { getDb } from "../db"

export function getActiveMissionConditionalBattleFactsSync(playerId: number): Record<string, number> {
    const rows = getDb().prepare(`
        SELECT pattern, character_id, progress
        FROM players_active_mission_battle_condition_facts
        WHERE player_id = ?
    `).all(playerId) as { pattern: number, character_id: number, progress: number }[]
    return Object.fromEntries(rows.map(row => [
        `${row.pattern}:${row.character_id}`,
        Math.max(0, row.progress),
    ]))
}

export function incrementActiveMissionConditionalBattleFactSync(
    playerId: number,
    pattern: number,
    characterId: number,
): void {
    if (!Number.isSafeInteger(pattern) || pattern <= 0
        || !Number.isSafeInteger(characterId) || characterId <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_battle_condition_facts (
            player_id, pattern, character_id, progress
        ) VALUES (?, ?, ?, 1)
        ON CONFLICT(player_id, pattern, character_id) DO UPDATE SET
            progress = progress + 1
    `).run(playerId, pattern, characterId)
}
