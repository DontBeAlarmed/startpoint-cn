import { getDb } from "../db"

export interface PlayerPartyCoClearCounter {
    char_id_a: number
    char_id_b: number
    co_clear_count: number
}

export function getPlayerPartyCoClearCountersSync(
    playerId: number,
): PlayerPartyCoClearCounter[] {
    return getDb().prepare(`
        SELECT char_id_a, char_id_b, co_clear_count
        FROM players_party_member_co_clears
        WHERE player_id = ?
    `).all(playerId) as PlayerPartyCoClearCounter[]
}
