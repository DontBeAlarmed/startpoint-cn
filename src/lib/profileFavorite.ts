import { getPlayerPartyGroupListSync } from "../data/domains/party"
import {
    PartyCategory,
    PlayerParty,
    PlayerPartyGroup,
    PROFILE_FAVORITE_PARTY_CATEGORY,
} from "../data/types"

export interface FavoritePartySelection {
    characterIds: (number | null)[]
    unisonCharacterIds: (number | null)[]
    equipmentIds: (number | null)[]
    abilitySoulIds: (number | null)[]
    name: string
    edited: boolean
    allowOtherPlayersToHealMe: boolean
    currentBattlePower: number
    beforeBattlePower: number
}

function triplet(values: (number | null)[] | undefined): (number | null)[] {
    return [values?.[0] ?? null, values?.[1] ?? null, values?.[2] ?? null]
}

function normalizeParty(party: PlayerParty): FavoritePartySelection {
    return {
        characterIds: triplet(party.characterIds),
        unisonCharacterIds: triplet(party.unisonCharacterIds),
        equipmentIds: triplet(party.equipmentIds),
        abilitySoulIds: triplet(party.abilitySoulIds),
        name: party.name || "Party A",
        edited: party.edited ?? false,
        allowOtherPlayersToHealMe: party.options?.allowOtherPlayersToHealMe ?? true,
        currentBattlePower: party.currentBattlePower ?? 0,
        beforeBattlePower: party.beforeBattlePower ?? 0,
    }
}

function firstParty(groups: Record<string, PlayerPartyGroup>): FavoritePartySelection | null {
    const groupEntries = Object.entries(groups).sort(
        ([left], [right]) => Number(left) - Number(right),
    )
    for (const [, group] of groupEntries) {
        const partyEntries = Object.entries(group.list || {}).sort(
            ([left], [right]) => Number(left) - Number(right),
        )
        if (partyEntries.length > 0) return normalizeParty(partyEntries[0][1])
    }
    return null
}

export function getFavoritePartySelectionSync(
    playerId: number,
    fallbackLeaderCharacterId: number,
): FavoritePartySelection {
    const favorite = firstParty(getPlayerPartyGroupListSync(
        playerId,
        PROFILE_FAVORITE_PARTY_CATEGORY,
    ))
    if (favorite) return favorite

    const normal = firstParty(getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL))
    if (normal) return normal

    return {
        characterIds: [fallbackLeaderCharacterId || 1, null, null],
        unisonCharacterIds: [null, null, null],
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        name: "Party A",
        edited: false,
        allowOtherPlayersToHealMe: true,
        currentBattlePower: 0,
        beforeBattlePower: 0,
    }
}

export function getFavoritePartyGroupListSync(
    playerId: number,
    fallbackLeaderCharacterId: number,
): any[] {
    const favoriteGroups = getPlayerPartyGroupListSync(
        playerId,
        PROFILE_FAVORITE_PARTY_CATEGORY,
    )
    const serialized = Object.entries(favoriteGroups)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([groupId, group]) => {
            const partyList = Object.entries(group.list || {})
                .sort(([left], [right]) => Number(left) - Number(right))
                .map(([slot, party]) => {
                    const normalized = normalizeParty(party)
                    return {
                        ability_soul_ids: normalized.abilitySoulIds,
                        character_ids: normalized.characterIds,
                        equipment_ids: normalized.equipmentIds,
                        options: {
                            allow_other_players_to_heal_me: normalized.allowOtherPlayersToHealMe,
                        },
                        party_edited: normalized.edited,
                        party_id: (Number(groupId) - 1) * 10 + Number(slot),
                        party_name: normalized.name,
                        unison_character_ids: normalized.unisonCharacterIds,
                        current_battle_power: normalized.currentBattlePower,
                        before_battle_power: normalized.beforeBattlePower,
                    }
                })
            return {
                party_group_color_id: group.colorId || 15,
                party_group_id: Number(groupId),
                party_list: partyList,
            }
        })
        .filter(group => group.party_list.length > 0)

    if (serialized.length > 0) return serialized

    const fallback = getFavoritePartySelectionSync(playerId, fallbackLeaderCharacterId)
    return [{
        party_group_color_id: 15,
        party_group_id: 1,
        party_list: [{
            ability_soul_ids: fallback.abilitySoulIds,
            character_ids: fallback.characterIds,
            equipment_ids: fallback.equipmentIds,
            options: { allow_other_players_to_heal_me: fallback.allowOtherPlayersToHealMe },
            party_edited: fallback.edited,
            party_id: 1,
            party_name: fallback.name,
            unison_character_ids: fallback.unisonCharacterIds,
            current_battle_power: fallback.currentBattlePower,
            before_battle_power: fallback.beforeBattlePower,
        }],
    }]
}
