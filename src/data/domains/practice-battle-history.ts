import { getDb } from "../db"
import {
    BATTLE_HISTORY_COLUMNS,
    BattleHistoryProtocolRecord,
    battleHistoryProtocolValues,
} from "./battle-history"

export interface PracticeBattleHistoryInsert extends BattleHistoryProtocolRecord {
    readonly playerId: number
    readonly playId: string
}

export function insertPlayerPracticeBattleHistorySync(
    record: PracticeBattleHistoryInsert,
): boolean {
    const placeholders = Array.from({ length: 31 }, () => "?").join(", ")
    const result = getDb().prepare(`
        INSERT OR IGNORE INTO players_practice_battle_history (
            player_id, play_id, ${BATTLE_HISTORY_COLUMNS}
        ) VALUES (${placeholders})
    `).run(record.playerId, record.playId, ...battleHistoryProtocolValues(record))
    return result.changes === 1
}

export function getPlayerPracticeBattleHistorySync(
    playerId: number,
): BattleHistoryProtocolRecord[] {
    return getDb().prepare(`
        SELECT ${BATTLE_HISTORY_COLUMNS}
        FROM players_practice_battle_history
        WHERE player_id = ? AND category_id = 15
        ORDER BY id DESC
    `).all(playerId) as BattleHistoryProtocolRecord[]
}
