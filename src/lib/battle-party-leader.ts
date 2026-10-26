import { getDb } from "../data/db"
import type { RawPlayerParty } from "../data/types"
import { parseGlobalPartyId } from "./special-event-parties"

// 房间/铃铛横幅的房主队长口径 = 房主**当前战斗所选编队**（party_id → 组×槽 →
// NORMAL 类别行一号位），与喜爱配队等社交信息完全解耦（维护者裁决 2026-10-27：
// 房间诚实展示当前玩家的配队状态）。multi 玩家快照读取器
// （player-snapshot-reader.findCurrentParty）用同一解析、同一类别行——横幅与
// guest 在大厅看到的房主编队同源。

export function resolveBattlePartyLeaderCharacterIdSync(
    playerId: number,
    partyId: number | null | undefined,
    storedLeaderId: number | null | undefined,
): number {
    const parsed = typeof partyId === "number" ? parseGlobalPartyId(partyId) : null
    if (parsed !== null) {
        const row = getDb().prepare(`
        SELECT character_id_1, character_id_2, character_id_3
        FROM players_parties
        WHERE player_id = ? AND group_id = ? AND slot = ? AND category = 1
        `).get(playerId, parsed.groupId, parsed.slot) as Pick<
            RawPlayerParty,
            "character_id_1" | "character_id_2" | "character_id_3"
        > | undefined
        for (const id of [row?.character_id_1, row?.character_id_2, row?.character_id_3]) {
            if (typeof id === "number" && id > 0) return id
        }
    }
    if (typeof storedLeaderId === "number" && storedLeaderId > 0) return storedLeaderId
    const owned = getDb().prepare(`
    SELECT id FROM players_characters WHERE player_id = ? ORDER BY id LIMIT 1
    `).get(playerId) as { id: number } | undefined
    return owned?.id ?? 1
}
