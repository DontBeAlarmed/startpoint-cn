import { getDb } from "../db"
import {
    BATTLE_HISTORY_COLUMNS,
    BATTLE_HISTORY_VALUES,
    BattleHistoryProtocolRecord,
    battleHistoryProtocolParameters,
} from "./battle-history"

export type ScoreAttackBattleHistoryRecord = BattleHistoryProtocolRecord

export interface ScoreAttackBattleHistoryInsert extends ScoreAttackBattleHistoryRecord {
    readonly playerId: number
    readonly eventId: number
    readonly playId: string
}

export function insertPlayerScoreAttackBattleHistorySync(
    record: ScoreAttackBattleHistoryInsert,
): boolean {
    const result = getDb().prepare(`
        INSERT OR IGNORE INTO players_score_attack_battle_history (
            player_id, event_id, play_id, ${BATTLE_HISTORY_COLUMNS}
        ) VALUES (@player_id, @event_id, @play_id, ${BATTLE_HISTORY_VALUES})
    `).run({
        player_id: record.playerId,
        event_id: record.eventId,
        play_id: record.playId,
        ...battleHistoryProtocolParameters(record),
    })
    return result.changes === 1
}

export function getPlayerScoreAttackBattleHistorySync(
    playerId: number,
    eventId: number,
): ScoreAttackBattleHistoryRecord[] {
    return getDb().prepare(`
        SELECT ${BATTLE_HISTORY_COLUMNS}
        FROM players_score_attack_battle_history
        WHERE player_id = ? AND event_id = ? AND category_id = 27
        ORDER BY id DESC
    `).all(playerId, eventId) as ScoreAttackBattleHistoryRecord[]
}
