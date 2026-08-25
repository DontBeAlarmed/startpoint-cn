import { getDb } from "../db"

export interface PlayerLoginBonusProgress {
    readonly playerId: number
    readonly groupId: string
    readonly lastGrantedIndex: number
    readonly lastGrantedBusinessDay: string
    readonly receivedAt: number
    readonly shownAt: number | null
}

interface PlayerLoginBonusProgressRow {
    player_id: number
    group_id: string
    last_granted_index: number
    last_granted_business_day: string
    received_at: number
    shown_at: number | null
}

function mapProgress(row: PlayerLoginBonusProgressRow): PlayerLoginBonusProgress {
    return {
        playerId: row.player_id,
        groupId: row.group_id,
        lastGrantedIndex: row.last_granted_index,
        lastGrantedBusinessDay: row.last_granted_business_day,
        receivedAt: row.received_at,
        shownAt: row.shown_at,
    }
}

export function listPlayerLoginBonusProgressSync(
    playerId: number,
): readonly PlayerLoginBonusProgress[] {
    return (getDb().prepare(`
        SELECT player_id, group_id, last_granted_index,
               last_granted_business_day, received_at, shown_at
        FROM players_login_bonus_progress
        WHERE player_id = ?
        ORDER BY group_id
    `).all(playerId) as PlayerLoginBonusProgressRow[]).map(mapProgress)
}

export function getPlayerLoginBonusProgressSync(
    playerId: number,
    groupId: string,
): PlayerLoginBonusProgress | null {
    const row = getDb().prepare(`
        SELECT player_id, group_id, last_granted_index,
               last_granted_business_day, received_at, shown_at
        FROM players_login_bonus_progress
        WHERE player_id = ? AND group_id = ?
    `).get(playerId, groupId) as PlayerLoginBonusProgressRow | undefined
    return row === undefined ? null : mapProgress(row)
}

export function upsertPlayerLoginBonusProgressSync(
    progress: PlayerLoginBonusProgress,
): void {
    getDb().prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, group_id) DO UPDATE SET
            last_granted_index = excluded.last_granted_index,
            last_granted_business_day = excluded.last_granted_business_day,
            received_at = excluded.received_at,
            shown_at = excluded.shown_at
    `).run(
        progress.playerId,
        progress.groupId,
        progress.lastGrantedIndex,
        progress.lastGrantedBusinessDay,
        progress.receivedAt,
        progress.shownAt,
    )
}

export function confirmPlayerLoginBonusShownSync(
    playerId: number,
    shownAt: number,
): number {
    return getDb().prepare(`
        UPDATE players_login_bonus_progress
        SET shown_at = ?
        WHERE player_id = ? AND shown_at IS NULL
    `).run(shownAt, playerId).changes
}

export type PlayerNormalLoginBonusProgress = Omit<PlayerLoginBonusProgress, "playerId">

export function getPlayerNormalLoginBonusProgressSync(
    playerId: number,
): PlayerNormalLoginBonusProgress | null {
    const progress = listPlayerLoginBonusProgressSync(playerId)
        .find(candidate => candidate.groupId.startsWith("normal"))
    if (progress === undefined) return null
    const { playerId: _playerId, ...normalProgress } = progress
    return normalProgress
}

export function upsertPlayerNormalLoginBonusProgressSync(
    playerId: number,
    progress: PlayerNormalLoginBonusProgress,
): void {
    upsertPlayerLoginBonusProgressSync({ playerId, ...progress })
}

export function confirmPlayerNormalLoginBonusShownSync(
    playerId: number,
    shownAt: number,
): boolean {
    return confirmPlayerLoginBonusShownSync(playerId, shownAt) > 0
}
