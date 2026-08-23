import { getDb } from "../db"

export interface PlayerPartyCoClearCounter {
    char_id_a: number
    char_id_b: number
    co_clear_count: number
}

const MAX_PARTY_CO_CLEAR_CHARACTER_IDS = Math.floor((32766 - 1) / 2)

function normalizeCharacterIds(ids: readonly number[]): number[] {
    const normalized = new Set<number>()
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new TypeError("party co-clear character IDs must be positive safe integers.")
        }
        normalized.add(id)
    }
    if (normalized.size > MAX_PARTY_CO_CLEAR_CHARACTER_IDS) {
        throw new RangeError(
            `party co-clear query cannot exceed ${MAX_PARTY_CO_CLEAR_CHARACTER_IDS} IDs.`,
        )
    }
    return [...normalized].sort((left, right) => left - right)
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

export function getPlayerPartyCoClearCountersByCharacterIdsSync(
    playerId: number,
    ids: readonly number[],
): PlayerPartyCoClearCounter[] {
    const characterIds = normalizeCharacterIds(ids)
    if (characterIds.length === 0) return []
    const placeholders = characterIds.map(() => "?").join(", ")
    return getDb().prepare(`
        SELECT char_id_a, char_id_b, co_clear_count
        FROM players_party_member_co_clears
        WHERE player_id = ?
            AND (char_id_a IN (${placeholders}) OR char_id_b IN (${placeholders}))
        ORDER BY char_id_a, char_id_b
    `).all(playerId, ...characterIds, ...characterIds) as PlayerPartyCoClearCounter[]
}
