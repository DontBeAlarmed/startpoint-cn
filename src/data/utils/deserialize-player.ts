import { deserializeClientDate } from "./date"
import { getCharacterDataSync } from "../../lib/assets"
import { getDateFromServerTime, getServerTime, getServerDate, realToVirtual } from "../../utils"
import { ClientPlayerData, DailyChallengePointListEntry, MergedPlayerData, PartyCategory, Player, PlayerBoxGacha, PlayerCharacter, PlayerCharacterBondToken, PlayerDrawnQuest, PlayerEquipment, PlayerGachaCampaign, PlayerGachaInfo, PlayerMultiSpecialExchangeCampaign, PlayerParty, PlayerPartyGroup, PlayerQuestProgress, PlayerRushEvent, PlayerRushEventPlayedParty, PlayerStartDashExchangeCampaign, RushEventBattleType, UserBoxGacha, UserCharacter, UserCharacterBondTokenStatus, UserEquipment, UserGachaCampaign, UserPartyGroup, UserPartyGroupTeam, UserQuestProgress, UserRushEvent, UserRushEventPlayedParty, UserRushEventPlayedPartyList, UserTutorial } from "../types"
import { deserializePlayerRushEventPlayedParty, deserializeRushEvent, getPlayerRushEventListClearedFoldersSync, getPlayerRushEventListPlayedPartiesSync, getPlayerRushEventListSync, serializePlayerRushEventPlayedParty } from "../domains/rushEvent"
import { getPlayerActiveMissionsSync, getPlayerClearedRegularMissionListSync } from "../domains/mission"
import { getPlayerBoxGachasSync } from "../domains/boxGacha"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../domains/character"
import { getPlayerDailyChallengePointListSync, getPlayerSync, updatePlayerSync } from "../domains/player"
import { getPlayerDrawnQuestsSync, getPlayerQuestProgressSync } from "../domains/quest"
import { getPlayerEquipmentListSync } from "../domains/equipment"
import { getPlayerGachaCampaignListSync, getPlayerGachaInfoListSync } from "../domains/gacha"
import { getPlayerItemsSync } from "../domains/item"
import { getPlayerMailCountSync } from "../domains/mail"
import { getPlayerMultiSpecialExchangeCampaignsSync, getPlayerPeriodicRewardPointsSync, getPlayerStartDashExchangeCampaignsSync } from "../domains/campaign"
import { getPlayerOptionsSync } from "../domains/option"
import { getPlayerPartyGroupListSync } from "../domains/party"
import { getPlayerTriggeredTutorialsSync } from "../domains/tutorial"
import { kIdToBusinessCode, businessCodeToKId } from "../codeMap"

/**
 * Deserializes client player data into data that can be processed by the server.
 * 
 * @param toDeserialize The client player data to be deserialized
 */
export function deserializePlayerData(
    playerId: number,
    toDeserialize: Partial<ClientPlayerData>
): MergedPlayerData {
    try {
        // deserialize user info
        const userInfo = toDeserialize['user_info']
        if (userInfo === undefined) throw new Error("Missing 'user_info' field.");

        const userTutorial = toDeserialize['user_tutorial']

        const player: Player = {
            id: playerId,
            stamina: userInfo.stamina,
            staminaHealTime: getDateFromServerTime(userInfo.stamina_heal_time),
            boostPoint: userInfo.boost_point,
            bossBoostPoint: userInfo.boss_boost_point,
            transitionState: userInfo.transition_state,
            role: userInfo.role,
            name: userInfo.name,
            lastLoginTime: deserializeClientDate(userInfo.last_login_time),
            comment: userInfo.comment,
            vmoney: userInfo.vmoney,
            freeVmoney: userInfo.free_vmoney,
            rankPoint: userInfo.rank_point,
            starCrumb: userInfo.star_crumb,
            bondToken: userInfo.bond_token,
            expPool: userInfo.exp_pool,
            expPooledTime: getDateFromServerTime(userInfo.exp_pooled_time),
            leaderCharacterId: userInfo.leader_character_id,
            partySlot: userInfo.party_slot,
            degreeId: userInfo.degree_id,
            birth: userInfo.birth,
            freeMana: userInfo.free_mana,
            paidMana: userInfo.paid_mana,
            enableAuto3x: userInfo.enable_auto_3x,
            totalStaminaUsed: 0,  // server-side counter, not in client data
            totalPowerflips: 0,
            totalDashes: 0,
        totalManaObtained: 0,
        maxComboAchieved: 0,
        totalLoginDays: 0,
            tutorialStep: userTutorial?.tutorial_step === undefined ? null : userTutorial.tutorial_step,
            tutorialSkipFlag: userTutorial?.skip_flag === undefined ? null : userTutorial.skip_flag,
            tutorialGachaCharacterId: toDeserialize['tutorial_gacha']?.character_id ?? null
        }

        // deserialize user daily challenge point list
        const userDailyChallengePointList = toDeserialize['user_daily_challenge_point_list']
        if (userDailyChallengePointList === undefined) throw new Error("Missing 'user_daily_challenge_point_list' field.");

        const dailyChallengePointList: DailyChallengePointListEntry[] = userDailyChallengePointList.map(dailyChallenge => {
            const id = dailyChallenge['id']
            const point = dailyChallenge['point']
            const campaignList = dailyChallenge['campaign_list']
            if (isNaN(id) || isNaN(point) || campaignList === undefined) throw new Error("Invalid user_daily_challenge_point_list field.");

            return {
                id: id,
                point: point,
                campaignList: campaignList.map(campaign => {
                    const id = campaign['campaign_id']
                    const additionalPoint = campaign['additional_point']
                    if (isNaN(id) || isNaN(additionalPoint)) throw new Error("Invalid user_daily_challenge_point_list campaign_list field.");

                    return {
                        campaignId: id,
                        additionalPoint: additionalPoint
                    }
                })
            }
        })

        // deserialize triggered tutorial
        const triggeredTutorial = toDeserialize['user_triggered_tutorial']
        if (triggeredTutorial === undefined) throw new Error("Missing 'user_triggered_tutorial' field.");

        // deserialize cleared regular mission list
        const clearedRegularMissionList = toDeserialize['cleared_regular_mission_list']
        if (clearedRegularMissionList === undefined) throw new Error("Missing 'cleared_regular_mission_list' field.");

        // deserialize character list
        const userCharacterList = toDeserialize['user_character_list']
        if (userCharacterList === undefined) throw new Error("Missing 'user_character_list' field.");

        const characterList: Record<string, PlayerCharacter> = {}
        for (const [characterId, character] of Object.entries(userCharacterList)) {
            // Convert business code → k_id for database storage
            const code = parseInt(characterId);
            const kId = businessCodeToKId(code);
            const kIdKey = String(kId);
            
            // get asset data (uses business code to look up)
            const assetData = getCharacterDataSync(characterId)
            if (assetData === null) throw new Error(`Character with id "${characterId}" does not exist.`);

            const entryCount = character['entry_count']
            const evolutionLevel = character['evolution_level']
            const overLimitStep = character['over_limit_step']
            const protection = character['protection']
            const joinTime = character['join_time']
            const updateTime = character['update_time']
            const exp = character['exp']
            const stack = character['stack']
            const bondTokenList = character['bond_token_list']
            const manaBoardIndex = character['mana_board_index']

            if (isNaN(entryCount) || isNaN(evolutionLevel) || isNaN(overLimitStep) || protection === undefined
                || isNaN(joinTime) || isNaN(updateTime) || isNaN(exp) || isNaN(stack) || bondTokenList === undefined
                || isNaN(manaBoardIndex)) throw new Error(`Invalid user_character_list value for character with id "${characterId}".`);

            // convert bond tokens
            const converted_character: PlayerCharacter = {
                entryCount: entryCount,
                evolutionLevel: evolutionLevel,
                overLimitStep: overLimitStep,
                protection: protection,
                joinTime: getDateFromServerTime(joinTime),
                updateTime: getDateFromServerTime(updateTime),
                exp: exp,
                stack: stack,
                manaBoardIndex: manaBoardIndex,
                bondTokenList: bondTokenList.map(bondToken => {
                    const manaBoardIndex = bondToken['mana_board_index']
                    const status = bondToken['status']
                    if (isNaN(manaBoardIndex) || isNaN(status)) throw new Error(`Invalid bond_token_list value for character with id "${characterId}".`);

                    return {
                        manaBoardIndex: manaBoardIndex,
                        status: status
                    }
                })
            }

            // validan length of bond token list
            if (bondTokenList.length > 2) throw new Error(`Invalid bond_token_list length for character with id "${characterId}".`);

            const exBoost = character['ex_boost']
            if (exBoost !== undefined) {
                const statusId = exBoost['status_id']
                if (isNaN(statusId)) throw new Error(`Invalid ex_boost value for character with id "${characterId}".`);

                converted_character['exBoost'] = {
                    statusId: statusId,
                    abilityIdList: exBoost['ability_id_list']
                }
            }

            if (character['illustration_settings'] !== undefined) {
                converted_character['illustrationSettings'] = character.illustration_settings
            }

            characterList[kIdKey] = converted_character
        }

        // deserialize mana node list (convert from client object format { mana_node_multiplied_id } to internal number[])
        const rawCharacterManaNodeList = toDeserialize['user_character_mana_node_list']
        if (rawCharacterManaNodeList === undefined) throw new Error("Missing 'user_character_mana_node_list' field.");
        const characterManaNodeList: Record<string, number[]> = {}
        const characterManaNodeAwakeLevels: Record<string, Record<number, number>> = {}
        for (const [charId, nodes] of Object.entries(rawCharacterManaNodeList)) {
            const typedNodes = nodes as { multiplied_id: number, awake_level?: number }[]
            characterManaNodeList[charId] = typedNodes.map(n => n.multiplied_id)
            for (const node of typedNodes) {
                if (node.awake_level === undefined) continue
                if (!Number.isSafeInteger(node.awake_level) || node.awake_level < 0) {
                    throw new Error(`Invalid awake_level for character ${charId}, node ${node.multiplied_id}.`)
                }
                if (!characterManaNodeAwakeLevels[charId]) characterManaNodeAwakeLevels[charId] = {}
                characterManaNodeAwakeLevels[charId][node.multiplied_id] = node.awake_level
            }
        }

        // deserialize party list
        const userPartyGroupList = toDeserialize['user_party_group_list']
        if (userPartyGroupList === undefined) throw new Error("Missing 'user_party_group_list' field.");

        const partyGroupList: Record<string, PlayerPartyGroup> = {}
        for (const [groupId, group] of Object.entries(userPartyGroupList)) {
            const userList = group['list']
            const colorId = group['color_id']
            if (isNaN(colorId)) throw new Error(`Invalid fields in group with id "${groupId}"`);

            const list: Record<string, PlayerParty> = {}
            for (const [partyId, party] of Object.entries(userList)) {
                const name = party['name']
                const characterIds = party['character_ids']
                const unisonCharacterIds = party['unison_character_ids']
                const equipmentIds = party['equipment_ids']
                const abilitySoulIds = party['ability_soul_ids']
                const edited = party['edited']
                const options = party['options']
                if (name === undefined || edited === undefined || options === undefined
                    || characterIds === undefined || unisonCharacterIds === undefined
                    || equipmentIds === undefined || abilitySoulIds === undefined
                ) throw new Error(`Invalid party team with id "${partyId}" in group with id "${groupId}"`);

                // check lengths
                if (characterIds.length > 3 || unisonCharacterIds.length > 3 || equipmentIds.length > 3 || abilitySoulIds.length > 3) throw new Error(`Invalid array lengths for party with id "${partyId}" in group with id "${groupId}"`);

                // Convert globalPartyId back to group-local slot: slot = (globalId - 1) % 10 + 1
                const localSlot = String((Number(partyId) - 1) % 10 + 1)
                list[localSlot] = {
                    name: name,
                    characterIds: characterIds?.map((id: number | null) => id != null ? businessCodeToKId(id) : 0),
                    unisonCharacterIds: unisonCharacterIds?.map((id: number | null) => id != null ? businessCodeToKId(id) : 0),
                    equipmentIds: equipmentIds,
                    abilitySoulIds: abilitySoulIds,
                    edited: edited,
                    options: {
                        allowOtherPlayersToHealMe: options?.allow_other_players_to_heal_me === undefined ? true : options.allow_other_players_to_heal_me
                    },
                    category: PartyCategory.NORMAL,
                    currentBattlePower: party['current_battle_power'] ?? 0,
                    beforeBattlePower: party['before_battle_power'] ?? 0
                }
            }
            partyGroupList[groupId] = {
                list: list,
                colorId: colorId,
                category: PartyCategory.NORMAL
            }
        }

        // deserialize item list
        const itemList = toDeserialize['item_list']
        if (itemList === undefined) throw new Error("Missing 'item_list' field.");

        // deserialize equipment
        const userEquipmentList = toDeserialize['user_equipment_list']
        if (userEquipmentList === undefined) throw new Error("Missing 'user_equipment_list' field.");

        const equipmentList: Record<string, PlayerEquipment> = {}
        for (const [equipmentId, equipment] of Object.entries(userEquipmentList)) {
            const enhancementLevel = equipment['enhancement_level']
            const level = equipment['level']
            const protection = equipment['protection']
            const stack = equipment['stack']
            if (isNaN(enhancementLevel) || isNaN(level) || protection === undefined || isNaN(stack)) throw new Error(`Invalid fields for equipment with id "${equipmentId}"`);

            equipmentList[equipmentId] = {
                enhancementLevel: enhancementLevel,
                level: level,
                protection: protection,
                stack: stack
            }
        }

        // deserialize quest progress
        const userQuestProgress = toDeserialize['quest_progress']
        if (userQuestProgress === undefined) throw new Error("Missing 'quest_progress' field.");

        const questProgress: Record<string, PlayerQuestProgress[]> = {}
        for (const [section, progresses] of Object.entries(userQuestProgress)) {
            const list: PlayerQuestProgress[] = []
            for (const progress of progresses) {
                const finished = progress['finished']
                const questId = progress['quest_id']
                if (isNaN(questId) || finished === undefined) throw new Error(`Invalid quest progress in section "${section}"`);

                list.push({
                    bestElapsedTimeMs: progress['best_elapsed_time_ms'],
                    clearRank: progress['clear_rank'],
                    finished: finished,
                    highScore: progress['high_score'],
                    questId: questId
                })
            }
            questProgress[section] = list
        }

        // deserialize gacha info list
        const userGachaInfoList = toDeserialize['gacha_info_list']
        if (userGachaInfoList === undefined) throw new Error("Missing 'gacha_info_list' field.");

        const gachaInfoList: PlayerGachaInfo[] = userGachaInfoList.map(gachaInfo => {
            const gachaId = gachaInfo['gacha_id']
            const isDailyFirst = gachaInfo['is_daily_first']
            const isAccountFirst = gachaInfo['is_account_first']
            if (isNaN(gachaId) || isDailyFirst === undefined || isAccountFirst === undefined) throw new Error(`Invalid or missing fields for 'gacha_info' field.`);

            return {
                gachaId: gachaId,
                isDailyFirst: isDailyFirst,
                isAccountFirst: isAccountFirst,
                gachaExchangePoint: gachaInfo['gacha_exchange_point']
            }
        })

        // deserialize gacha campaign list
        const userGachaCampaignList = toDeserialize['gacha_campaign_list']
        let gachaCampaignList: PlayerGachaCampaign[] = []
        if (userGachaCampaignList !== undefined) {
            gachaCampaignList = userGachaCampaignList.map(rawCampaign => {
                const gachaId = rawCampaign['gacha_id']
                const campaignId = rawCampaign['campaign_id']
                const count = rawCampaign['count']
                if (isNaN(gachaId) || isNaN(campaignId) || isNaN(count)) throw new Error(`Invalid or missing fields for 'gacha_campaign_list' field.`);

                return {
                    gachaId: gachaId,
                    campaignId: campaignId,
                    count: count
                }
            })
        }

        // deserialize player options
        const userOption = toDeserialize['user_option']
        if (userOption === undefined) throw new Error("Missing 'user_option' field.");

        // deserialize drawn quest list
        const userDrawnQuestList = toDeserialize['drawn_quest_list']
        if (userDrawnQuestList === undefined) throw new Error("Missing 'drawn_quest_list' field.");

        const drawnQuestList: PlayerDrawnQuest[] = userDrawnQuestList.map(drawnQuest => {
            const categoryId = drawnQuest['category_id']
            const questId = drawnQuest['quest_id']
            const oddsId = drawnQuest['odds_id']

            if (isNaN(categoryId) || isNaN(questId) || isNaN(oddsId)) throw new Error(`Invalid or missing fields for 'drawn_quest_list' field.`);

            return {
                categoryId: categoryId,
                questId: questId,
                oddsId: oddsId
            }
        })

        // deserialize periodic reward point list
        const periodicRewardPointList = toDeserialize['user_periodic_reward_point_list']
        if (periodicRewardPointList === undefined) throw new Error("Missing 'user_periodic_reward_point_list' field.");

        // deserialize active mission list
        const allActiveMissionList = toDeserialize['all_active_mission_list']
        if (allActiveMissionList === undefined) throw new Error("Missing 'all_active_mission_list' field.");

        // convert box gacha list
        const userBoxGachaList = toDeserialize['box_gacha_list']
        if (userBoxGachaList === undefined) throw new Error("Missing 'box_gacha_list' field.");

        const boxGachaList: Record<string, PlayerBoxGacha[]> = {}
        for (const [section, list] of Object.entries(userBoxGachaList)) {
            boxGachaList[section] = list.map(boxGacha => {
                const boxId = boxGacha['box_id']
                const resetTimes = boxGacha['reset_times']
                const remainingNumber = boxGacha['remaining_number']
                const isClosed = boxGacha['is_closed']

                if (isNaN(boxId) || isNaN(resetTimes) || isNaN(remainingNumber) || isClosed === undefined) throw new Error(`Invalid or missing fields for 'box_gacha_list' field in section ${section}.`);

                return {
                    boxId: boxId,
                    resetTimes: resetTimes,
                    remainingNumber: remainingNumber,
                    isClosed: isClosed
                }
            })
        }

        // deserialize start dash exchange campaign list
        const userStartDashCampaignList = toDeserialize['start_dash_exchange_campaign_list']
        if (userStartDashCampaignList === undefined) throw new Error("Missing 'start_dash_exchange_campaign_list' field.");

        const startDashExchangeCampaignList: PlayerStartDashExchangeCampaign[] = userStartDashCampaignList.map(campaign => {
            const campaignId = campaign['campaign_id']
            const gachaId = campaign['gacha_id']
            const periodStartTime = campaign['period_start_time']
            const periodEndTime = campaign['period_end_time']
            const status = campaign['status']
            const termIndex = campaign['term_index']

            if (isNaN(campaignId) || isNaN(gachaId) || isNaN(periodStartTime) || isNaN(periodEndTime) || isNaN(status) || isNaN(termIndex))
                throw new Error("Invalid or missing fields for 'start_dash_exchange_campaign_list' field.");

            return {
                campaignId: campaignId,
                gachaId: gachaId,
                periodStartTime: getDateFromServerTime(periodStartTime),
                periodEndTime: getDateFromServerTime(periodEndTime),
                status: status,
                termIndex: termIndex
            }
        })

        // deserialize multi special exchange campaign list
        const userMultiSpecialExchangeCampaignList = toDeserialize['multi_special_exchange_campaign_list']

        let multiSpecialExchangeCampaignList: PlayerMultiSpecialExchangeCampaign[] = []
        if (userMultiSpecialExchangeCampaignList !== undefined) {
            multiSpecialExchangeCampaignList = userMultiSpecialExchangeCampaignList.map(campaign => {
                const campaignId = campaign['campaign_id']
                const status = campaign['status']
    
                if (isNaN(campaignId) || isNaN(status))
                    throw new Error("Invalid or missing fields for 'multi_special_exchange_campaign_list' field.");
    
                return {
                    campaignId: campaignId,
                    status: status
                }
            })
        }
        
        // deserialize rush event data
        const userRushEventList = toDeserialize['user_rush_event_list']
        const rushEventList: PlayerRushEvent[] = []
        if (userRushEventList !== undefined) {
            for (const [eventId, rushEvent] of Object.entries(userRushEventList)) {
                rushEventList.push(deserializeRushEvent({
                    event_id: Number(eventId),
                    player_id: playerId,
                    ...rushEvent
                }, 0))
            }
        }
        
        // deserialize rush event played party group list data
        const userRushEventPlayedPartyList = toDeserialize['user_rush_event_played_party_list']
        let rushEventPlayedPartyList: Record<string, PlayerRushEventPlayedParty[]> | undefined = undefined
        if (userRushEventPlayedPartyList !== undefined) {
            rushEventPlayedPartyList = {}

            for (const [eventId, battleTypeParties] of Object.entries(userRushEventPlayedPartyList)) {
                const mappedParties: PlayerRushEventPlayedParty[] = []

                for (const [battleType, parties] of Object.entries(battleTypeParties)) {
                    for (const [round, party] of Object.entries(parties)) {
                        mappedParties.push(deserializePlayerRushEventPlayedParty({
                            player_id: 0,
                            event_id: 0,
                            round: Number(round),
                            battle_type: Number(battleType),
                            ...party
                        }))
                    }
                }
                rushEventPlayedPartyList[eventId] = mappedParties
            }
        }

        return {
            player: player,
            dailyChallengePointList: dailyChallengePointList,
            triggeredTutorial: triggeredTutorial,
            clearedRegularMissionList: clearedRegularMissionList,
            characterList: characterList,
            characterManaNodeList: characterManaNodeList,
            characterManaNodeAwakeLevels: characterManaNodeAwakeLevels,
            partyGroupList: partyGroupList,
            itemList: itemList,
            equipmentList: equipmentList,
            questProgress: questProgress,
            gachaInfoList: gachaInfoList,
            gachaCampaignList: gachaCampaignList,
            drawnQuestList: drawnQuestList,
            periodicRewardPointList: periodicRewardPointList,
            allActiveMissionList: allActiveMissionList,
            boxGachaList: boxGachaList,
            purchasedTimesList: {},
            startDashExchangeCampaignList: startDashExchangeCampaignList,
            multiSpecialExchangeCampaignList: multiSpecialExchangeCampaignList,
            userOption: userOption,
            rushEventList: rushEventList.length === 0 ? undefined : rushEventList,
            rushEventClearedFolderList: toDeserialize['user_rush_event_cleared_folder_list'],
            rushEventPlayedPartyList: rushEventPlayedPartyList
        }

    } catch (error: Error | any) {
        throw error
    }
}
