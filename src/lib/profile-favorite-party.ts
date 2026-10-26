import { getDb } from "../data/db"
import { getPlayerCharacterSync } from "../data/domains/character"
import { updatePlayerSync } from "../data/domains/player"
import { getFavoritePartySelectionSync } from "./profileFavorite"

// 资料页展示编队（profile/get_profile 的 favorite_character）。客户端契约
// （ProfileGetProfileRealRemote + OtherProfileLogic）：character_ids[0] 是
// 队长立绘角色，资料页按数组长度逐位布局 EX Boost——**数组不允许为空**，
// 空数组会让 PlayerProfileView.layoutPartyExBoost 读 [0].index 时抛
// TypeError #1009（F1009 崩溃上报）。
//
// 数据源是玩家配置的**喜爱配队**（ProfilePartyGroupSource，category 99，
// party/edit 已落库），回退链官方口径 = 喜爱编队 → 普通第一编队 → 队长占位
//（getFavoritePartySelectionSync 原生实现）。资料队长（leader_character_id
// 的官方语义）跟随该编队一号位。

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

/** 资料队长（权威口径）：喜爱配队（回退普通第一编队）首位非空角色；编队
 * 全空时退回存档字段，再退回首个拥有角色。0 表示无任何可用角色。 */
export function resolveEffectiveLeaderCharacterIdSync(
    playerId: number,
    storedLeaderId: number | null | undefined,
): number {
    const selection = getFavoritePartySelectionSync(playerId, storedLeaderId ?? 0)
    const fromSelection = firstNonEmptyCharacterId(selection.characterIds)
    if (fromSelection !== null) return fromSelection
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

/** 喜爱配队 → favorite_character 协议形状（3 主位 + 3 共鸣位，逐位
 * EX Boost）。getFavoritePartySelectionSync 永不返回空，客户端可安全按位
 * 解引用。 */
export function buildFavoriteCharacterPartySync(
    playerId: number,
    storedLeaderId: number | null | undefined,
): FavoriteCharacterParty {
    const selection = getFavoritePartySelectionSync(playerId, storedLeaderId ?? 0)
    const characterIds = [
        selection.characterIds[0] ?? null,
        selection.characterIds[1] ?? null,
        selection.characterIds[2] ?? null,
    ]
    const unisonCharacterIds = [
        selection.unisonCharacterIds[0] ?? null,
        selection.unisonCharacterIds[1] ?? null,
        selection.unisonCharacterIds[2] ?? null,
    ]
    return {
        character_ids: characterIds,
        unison_character_ids: unisonCharacterIds,
        character_ex_boost: characterIds.map(id => buildExBoostEntrySync(playerId, id)),
        unison_character_ex_boost: unisonCharacterIds.map(id => buildExBoostEntrySync(playerId, id)),
    }
}

/** 把 players.leader_character_id 联动到喜爱配队一号位（官方语义：资料队长
 * = 资料展示编队首位角色；未配置喜爱配队时回退普通第一编队）。须在
 * party/edit 的事务内调用（upsert 之后，读取本次请求写入后的编队行）。
 * 无非空成员则保持现值。返回写回后的队长 id。 */
export function refreshMainPartyLeaderSync(playerId: number, currentLeaderId: number): number {
    const selection = getFavoritePartySelectionSync(playerId, currentLeaderId)
    const nextLeader = firstNonEmptyCharacterId(selection.characterIds) ?? currentLeaderId
    if (nextLeader !== currentLeaderId) {
        updatePlayerSync({ id: playerId, leaderCharacterId: nextLeader })
    }
    return nextLeader
}
