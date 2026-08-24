import { getDb } from "../db"

export interface PlayerNormalLoginBonusProgress {
    readonly groupId: string
    readonly lastGrantedIndex: number
    readonly lastGrantedBusinessDay: string
    readonly receivedAt: number
    readonly shownAt: number | null
}

interface PlayerNormalLoginBonusProgressRow {
    group_id: string
    last_granted_index: number
    last_granted_business_day: string
    received_at: number
    shown_at: number | null
}

export function getPlayerNormalLoginBonusProgressSync(
    playerId: number,
): PlayerNormalLoginBonusProgress | null {
    const row = getDb().prepare(`
        SELECT group_id, last_granted_index, last_granted_business_day, received_at, shown_at
        FROM players_login_bonus_progress
        WHERE player_id = ?
    `).get(playerId) as PlayerNormalLoginBonusProgressRow | undefined
    if (row === undefined) return null
    return {
        groupId: row.group_id,
        lastGrantedIndex: row.last_granted_index,
        lastGrantedBusinessDay: row.last_granted_business_day,
        receivedAt: row.received_at,
        shownAt: row.shown_at,
    }
}

export function upsertPlayerNormalLoginBonusProgressSync(
    playerId: number,
    progress: PlayerNormalLoginBonusProgress,
): void {
    getDb().prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id,
            group_id,
            last_granted_index,
            last_granted_business_day,
            received_at,
            shown_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            group_id = excluded.group_id,
            last_granted_index = excluded.last_granted_index,
            last_granted_business_day = excluded.last_granted_business_day,
            received_at = excluded.received_at,
            shown_at = excluded.shown_at
    `).run(
        playerId,
        progress.groupId,
        progress.lastGrantedIndex,
        progress.lastGrantedBusinessDay,
        progress.receivedAt,
        progress.shownAt,
    )
}

export function confirmPlayerNormalLoginBonusShownSync(
    playerId: number,
    shownAt: number,
): boolean {
    return getDb().prepare(`
        UPDATE players_login_bonus_progress
        SET shown_at = ?
        WHERE player_id = ? AND shown_at IS NULL
    `).run(shownAt, playerId).changes > 0
}
