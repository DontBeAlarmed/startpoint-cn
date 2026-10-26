import { getDb } from "../data/db"
import { getPlayerCharacterSync } from "../data/domains/character"
import { getMainBattlePartySync } from "../data/domains/party"
import { updatePlayerSync } from "../data/domains/player"

// 资料页展示编队（profile/get_profile 的 favorite_character）。客户端契约
// （ProfileGetProfileRealRemote + OtherProfileLogic）：character_ids[0] 是
// 队长立绘角色，资料页按数组长度逐位布局 EX Boost——**数组不允许为空**，
// 空数组会让 PlayerProfileView.layoutPartyExBoost 读 [0].index 时抛
// TypeError #1009（F1009 崩溃上报）。因此这里永远返回至少一个主队伍槽位，
// 队长（一号位）取主队伍首位非空角色。

export interface FavoriteCharacterExBoostEntry {
    readonly ability_id_list: number[]
    readonly status_id: number
}

export interface FavoriteCharacterParty {
    readonly character_ids: (number | null)[]
    readonly unison_character_ids: (number | null)[]
    readonly character_ex_boost: (FavoriteCharacterExBoostEntry | null)[]
    readonly unison_character_ex_boost: (FavoriteCharacterExBoostEntry | null)[]
}

function firstNonEmptyCharacterId(ids: readonly (number | null)[]): number | null {
    for (const id of ids) {
        if (id !== null && id > 0) return id
    }
    return null
}

function firstOwnedCharacterIdSync(playerId: number): number | null {
    const row = getDb().prepare(`
    SELECT id FROM players_characters WHERE player_id = ? ORDER BY id LIMIT 1
    `).get(playerId) as { id: number } | undefined
    return row?.id ?? null
}

/** 资料队长（权威口径）：主队伍首位非空角色；队伍缺失时退回存档字段，
 * 再退回首个拥有角色。0 表示该玩家没有任何可用角色（理论上不存在）。 */
export function resolveEffectiveLeaderCharacterIdSync(
    playerId: number,
    storedLeaderId: number | null | undefined,
    partySlot: number,
): number {
    const mainParty = getMainBattlePartySync(playerId, partySlot)
    const fromParty = mainParty === null ? null : firstNonEmptyCharacterId(mainParty.characterIds)
    if (fromParty !== null) return fromParty
    if (typeof storedLeaderId === "number" && storedLeaderId > 0) return storedLeaderId
    return firstOwnedCharacterIdSync(playerId) ?? 0
}

function buildExBoostEntrySync(playerId: number, characterId: number | null): FavoriteCharacterExBoostEntry | null {
    if (characterId === null || characterId <= 0) return null
    const exBoost = getPlayerCharacterSync(playerId, characterId)?.exBoost ?? undefined
    if (exBoost === undefined
        || !(exBoost.statusId > 0)
        || exBoost.abilityIdList.length === 0) {
        return null
    }
    return { status_id: exBoost.statusId, ability_id_list: [...exBoost.abilityIdList] }
}

/** 把 players.leader_character_id 联动到主队伍一号位（官方语义：资料队长
 * = 当前主队伍首位角色）。须在 party/edit 的事务内调用；主队伍首位为空时
 * 沿用顺位后的首位，无任何成员则保持现值。返回写回后的队长 id。 */
export function refreshMainPartyLeaderSync(playerId: number, mainPartyId: number, currentLeaderId: number): number {
    const mainParty = getMainBattlePartySync(playerId, mainPartyId)
    const nextLeader = mainParty?.characterIds.find(id => id !== null && id > 0)
        ?? currentLeaderId
    if (nextLeader !== currentLeaderId) {
        updatePlayerSync({ id: playerId, leaderCharacterId: nextLeader })
    }
    return nextLeader
}

/** 主队伍 → favorite_character 协议形状（3 主位 + 2 共鸣位，逐位 EX Boost）。
 * 主队伍行缺失时退化为 [队长, null, null] 的最小合法编队。 */
export function buildFavoriteCharacterPartySync(
    playerId: number,
    partySlot: number | null | undefined,
    storedLeaderId: number | null | undefined,
): FavoriteCharacterParty {
    const mainParty = typeof partySlot === "number"
        ? getMainBattlePartySync(playerId, partySlot)
        : null
    const characterIds = mainParty?.characterIds ?? []
    const unisonCharacterIds = mainParty?.unisonCharacterIds ?? []
    const finalCharacterIds = characterIds.length > 0
        ? characterIds
        : [resolveEffectiveLeaderCharacterIdSync(playerId, storedLeaderId, partySlot ?? 0), null, null]
    return {
        character_ids: finalCharacterIds,
        unison_character_ids: unisonCharacterIds,
        character_ex_boost: finalCharacterIds.map(id => buildExBoostEntrySync(playerId, id)),
        unison_character_ex_boost: unisonCharacterIds.map(id => buildExBoostEntrySync(playerId, id)),
    }
}
