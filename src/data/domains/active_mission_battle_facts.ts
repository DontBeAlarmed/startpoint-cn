import { getDb } from "../db"

export function getActiveMissionBattleFactsSync(playerId: number): Record<string, number> {
    const rows = getDb().prepare(`
        SELECT mission_id, progress
        FROM players_active_mission_battle_facts
        WHERE player_id = ?
    `).all(playerId) as { mission_id: number, progress: number }[]
    return Object.fromEntries(rows.map(row => [
        String(row.mission_id),
        Math.max(0, row.progress),
    ]))
}

export function incrementActiveMissionBattleFactSync(
    playerId: number,
    missionId: number,
    amount = 1,
): void {
    if (!Number.isSafeInteger(missionId) || missionId <= 0
        || !Number.isSafeInteger(amount) || amount <= 0) return
    getDb().prepare(`
        INSERT INTO players_active_mission_battle_facts (
            player_id, mission_id, progress
        ) VALUES (?, ?, ?)
        ON CONFLICT(player_id, mission_id) DO UPDATE SET
            progress = progress + excluded.progress
    `).run(playerId, missionId, amount)
}
