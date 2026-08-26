import { getDb } from "../db"
import {
    BATTLE_HISTORY_COLUMNS,
    BATTLE_HISTORY_VALUES,
    BattleHistoryProtocolRecord,
    battleHistoryProtocolParameters,
} from "./battle-history"

export interface PracticeBattleHistoryInsert extends BattleHistoryProtocolRecord {
    readonly playerId: number
    readonly playId: string
}

const PRACTICE_HISTORY_RETURN_LIMIT = 30
const PRACTICE_HISTORY_RETAIN_LIMIT = 100

export function insertPlayerPracticeBattleHistorySync(
    record: PracticeBattleHistoryInsert,
): boolean {
    const db = getDb()
    const write = () => {
        const result = db.prepare(`
            INSERT OR IGNORE INTO players_practice_battle_history (
                player_id, play_id, ${BATTLE_HISTORY_COLUMNS}
            ) VALUES (@player_id, @play_id, ${BATTLE_HISTORY_VALUES})
        `).run({
            player_id: record.playerId,
            play_id: record.playId,
            ...battleHistoryProtocolParameters(record),
        })
        if (result.changes === 1) {
            db.prepare(`
                DELETE FROM players_practice_battle_history
                WHERE player_id = ? AND id NOT IN (
                    SELECT id
                    FROM players_practice_battle_history
                    WHERE player_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                )
            `).run(record.playerId, record.playerId, PRACTICE_HISTORY_RETAIN_LIMIT)
        }
        return result.changes === 1
    }
    return db.inTransaction ? write() : db.transaction(write)()
}

export function getPlayerPracticeBattleHistorySync(
    playerId: number,
    limit = PRACTICE_HISTORY_RETURN_LIMIT,
): BattleHistoryProtocolRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PRACTICE_HISTORY_RETAIN_LIMIT) {
        throw new RangeError("practice battle history limit must be between 1 and 100")
    }
    return getDb().prepare(`
        SELECT ${BATTLE_HISTORY_COLUMNS}
        FROM players_practice_battle_history
        WHERE player_id = ? AND category_id = 15
        ORDER BY id DESC
        LIMIT ?
    `).all(playerId, limit) as BattleHistoryProtocolRecord[]
}
