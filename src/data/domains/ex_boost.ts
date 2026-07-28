import { getDb } from "../db"
import { deserializeNumberList, serializeNumberList } from "../utils"

export interface PendingExBoostDraw {
    characterId: number
    statusId: number
    abilityIdList: number[]
}

interface RawPendingExBoostDraw {
    character_id: number
    status_id: number
    ability_id_list: string
}

export function getPendingExBoostDrawSync(playerId: number): PendingExBoostDraw | null {
    const row = getDb().prepare(`
        SELECT character_id, status_id, ability_id_list
        FROM players_ex_boost_pending_draws
        WHERE player_id = ?
    `).get(playerId) as RawPendingExBoostDraw | undefined
    if (!row) return null
    return {
        characterId: row.character_id,
        statusId: row.status_id,
        abilityIdList: deserializeNumberList(row.ability_id_list),
    }
}

export function upsertPendingExBoostDrawSync(
    playerId: number,
    draw: PendingExBoostDraw,
): void {
    getDb().prepare(`
        INSERT INTO players_ex_boost_pending_draws (
            player_id, character_id, status_id, ability_id_list
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            character_id = excluded.character_id,
            status_id = excluded.status_id,
            ability_id_list = excluded.ability_id_list
    `).run(
        playerId,
        draw.characterId,
        draw.statusId,
        serializeNumberList(draw.abilityIdList),
    )
}

export function deletePendingExBoostDrawSync(playerId: number): void {
    getDb().prepare(`
        DELETE FROM players_ex_boost_pending_draws
        WHERE player_id = ?
    `).run(playerId)
}
