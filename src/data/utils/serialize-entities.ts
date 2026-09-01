import { ClientPlayerData, DailyChallengePointListEntry, MergedPlayerData, PartyCategory, Player, PlayerBoxGacha, PlayerDrawnQuest, PlayerEquipment, PlayerGachaCampaign, PlayerGachaInfo, PlayerMultiSpecialExchangeCampaign, PlayerParty, PlayerPartyGroup, PlayerQuestProgress, PlayerRushEvent, PlayerRushEventPlayedParty, PlayerStartDashExchangeCampaign, RushEventBattleType, UserBoxGacha, UserCharacter, UserEquipment, UserGachaCampaign, UserPartyGroup, UserPartyGroupTeam, UserQuestProgress, UserRushEvent, UserRushEventPlayedParty, UserRushEventPlayedPartyList, UserTutorial } from "../types"
import { kIdToBusinessCode, businessCodeToKId } from "../codeMap"

/**
 * Serializes a PlayerGachaCampaign into a UserGachaCampaign.
 * 
 * @param campaign 
 * @returns 
 */
export function serializeGachaCampaign(
    campaign: PlayerGachaCampaign
): UserGachaCampaign {
    return {
        gacha_id: campaign.gachaId,
        campaign_id: campaign.campaignId,
        count: campaign.count
    }
}


/**
 * Converts a record of PlayerPartyGroup objects into a record of UserPartyGroup objects.
 * 
 * @param partyGrouplist 
 * @returns 
 */
export function serializePartyGroupList(
    partyGrouplist: Record<string, PlayerPartyGroup>
): Record<string, UserPartyGroup> {
    const serialized: Record<string, UserPartyGroup> = {}
    for (const [groupId, group] of Object.entries(partyGrouplist)) {
        const list: Record<string, UserPartyGroupTeam> = {}
        for (const [slot, party] of Object.entries(group.list)) {
            // Convert per-group slot to CN global PartyId: (groupId - 1) * 10 + slot
            const globalPartyId = (Number(groupId) - 1) * 10 + Number(slot)
            list[globalPartyId] = {
                "name": party.name,
                "character_ids": party.characterIds?.map((id: number | null) => id != null ? kIdToBusinessCode(id) : null),
                "unison_character_ids": party.unisonCharacterIds?.map((id: number | null) => id != null ? kIdToBusinessCode(id) : null),
                "equipment_ids": party.equipmentIds,
                "ability_soul_ids": party.abilitySoulIds,
                "edited": party.edited,
                "options": {
                    "allow_other_players_to_heal_me": party.options.allowOtherPlayersToHealMe
                },
                "current_battle_power": party.currentBattlePower ?? 0,
                "before_battle_power": party.beforeBattlePower ?? 0
            }
        }
        serialized[groupId] = {
            "list": list,
            "color_id": group.colorId
        }
    }
    return serialized
}


/**
 * Serializes a PlayerRushEvent into a UserRushEvent.
 * 
 * @param rushEvent The data for the rush event.
 */
export function serializeRushEvent(
    rushEvent: PlayerRushEvent
): UserRushEvent {
    const characterIds = rushEvent.endlessBattleMaxRoundCharacterIds
    const characterEvolutionImgLevels = rushEvent.endlessBattleMaxRoundCharacterEvolutionImgLvls
    return {
        active_rush_battle_folder_id: rushEvent.activeRushBattleFolderId,
        endless_battle_max_round: rushEvent.endlessBattleMaxRound,
        endless_battle_max_round_time: rushEvent.endlessBattleMaxRoundTime,
        endless_battle_max_round_character_id_1: characterIds?.[0] != null ? kIdToBusinessCode(characterIds[0]) : null,
        endless_battle_max_round_character_id_2: characterIds?.[1] != null ? kIdToBusinessCode(characterIds[1]) : null,
        endless_battle_max_round_character_id_3: characterIds?.[2] != null ? kIdToBusinessCode(characterIds[2]) : null,
        endless_battle_max_round_character_evolution_img_lvl_1: characterEvolutionImgLevels?.[0],
        endless_battle_max_round_character_evolution_img_lvl_2: characterEvolutionImgLevels?.[1],
        endless_battle_max_round_character_evolution_img_lvl_3: characterEvolutionImgLevels?.[2],
    }
}
