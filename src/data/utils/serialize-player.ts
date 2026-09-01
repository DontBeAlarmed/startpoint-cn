import { clientSerializeDate } from "./date"
import { resolveSerializedAssetVersion } from "./serialized-asset-version"
import { serializePartyGroupList, serializeGachaCampaign, serializeRushEvent } from "./serialize-entities"
import { getServerTime, realToVirtual } from "../../utils"
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time"
import { ClientPlayerData, MergedPlayerData, PlayerQuestProgress, RushEventBattleType, UserBoxGacha, UserEquipment, UserPartyGroup, UserQuestProgress, UserRushEvent, UserRushEventPlayedParty, UserRushEventPlayedPartyList, UserTutorial } from "../types"
import { serializePlayerRushEventPlayedParty } from "../domains/rushEvent"
import { getPlayerClearedCollectItemEventMissionListSync } from "../domains/mission"
import { updatePlayerSync } from "../domains/player"
import { getPlayerMailCountSync } from "../domains/mail"
import { kIdToBusinessCode } from "../codeMap"
import { getCharacterVisibleManaBoardIndex } from "../../lib/mana-board-availability"
import { computeRealTimeStamina } from "../../lib/stamina"
import { isStartTutorialActive } from "../../lib/start-tutorial-state"
import { getRealNow } from "../../runtime/time/game-time"
import { createCharacterGrowthBatchContext } from "../../lib/character-growth/batch-context"
import { projectCharacterGrowthLoad } from "../../lib/character-growth/load-projector"
import type { BondTokenStatus, CharacterGrowthStoredCore } from "../../lib/character-growth/model"
import { getCharacterDataSync } from "../../lib/assets"

export interface SerializePlayerDataOptions {
    viewerId?: number
    serializeRushEventData?: boolean // should rush event data be serialized?
    activeMissionList?: { mission_id: number; progress_value: number; stages: { stage: number; received: boolean }[] }[]
    availableAssetVersion?: string
    summonComSeconds?: number
}

export function serializePlayerQuestProgress(progress: PlayerQuestProgress): UserQuestProgress {
    return {
        "best_elapsed_time_ms": progress.bestElapsedTimeMs,
        "clear_rank": progress.clearRank,
        "finished": progress.finished,
        "high_score": progress.highScore ?? 0,
        "quest_id": progress.questId,
        "unlocked": progress.unlocked,
        ...(progress.hostFinished !== undefined
            ? { "host_finished": progress.hostFinished }
            : {}),
    }
}

function assertCharacterRecordKeys(
    record: Readonly<Record<string, unknown>> | undefined,
    characterIds: ReadonlySet<number>,
    field: string,
): void {
    if (record === undefined) return
    for (const rawCharacterId of Object.keys(record)) {
        const characterId = Number(rawCharacterId)
        if (!Number.isSafeInteger(characterId)
            || characterId <= 0
            || String(characterId) !== rawCharacterId
            || !characterIds.has(characterId)) {
            throw new Error(`${field} contains unknown character ${rawCharacterId}`)
        }
    }
}

function projectSerializedCharacterGrowth(toSerialize: MergedPlayerData) {
    const characterIds = Object.keys(toSerialize.characterList).map(rawCharacterId => {
        const characterId = Number(rawCharacterId)
        if (!Number.isSafeInteger(characterId) || characterId <= 0 || String(characterId) !== rawCharacterId) {
            throw new Error(`characterList contains invalid character ${rawCharacterId}`)
        }
        return characterId
    })
    const characterIdSet = new Set(characterIds)
    assertCharacterRecordKeys(toSerialize.characterManaNodeList, characterIdSet, "characterManaNodeList")
    assertCharacterRecordKeys(
        toSerialize.characterManaNodeAwakeLevels,
        characterIdSet,
        "characterManaNodeAwakeLevels",
    )
    assertCharacterRecordKeys(toSerialize.characterAwakeUnlocks, characterIdSet, "characterAwakeUnlocks")
    if (toSerialize.manaBoardAwakeMap !== undefined) {
        assertCharacterRecordKeys(
            Object.fromEntries(toSerialize.manaBoardAwakeMap),
            characterIdSet,
            "manaBoardAwakeMap",
        )
    }

    const storedCharactersSnapshot: Record<string, CharacterGrowthStoredCore> = {}
    const bondTokenSnapshots: Record<string, ReadonlyMap<number, BondTokenStatus>> = {}
    const normalManaNodeSnapshots: Record<string, ReadonlyMap<number, number>> = {}
    const awakeUnlockSnapshots: Record<string, ReadonlyMap<number, number>> = {}
    const visibleManaBoardIndexes = new Map<number, number>()
    const rarityByCharacter = new Map<number, number | null>()

    for (const characterId of characterIds) {
        const key = String(characterId)
        const character = toSerialize.characterList[key]
        storedCharactersSnapshot[key] = {
            characterId,
            exp: character.exp,
            stack: character.stack,
            protection: character.protection,
            overLimitStep: character.overLimitStep,
            evolutionLevel: character.evolutionLevel,
            manaBoardIndex: character.manaBoardIndex,
        }
        bondTokenSnapshots[key] = new Map(character.bondTokenList.map(token => [
            token.manaBoardIndex,
            token.status as BondTokenStatus,
        ]))

        const nodeIds = toSerialize.characterManaNodeList[key] ?? []
        if (new Set(nodeIds).size !== nodeIds.length) {
            throw new Error(`characterManaNodeList contains duplicate nodes for character ${characterId}`)
        }
        const awakeLevels = toSerialize.characterManaNodeAwakeLevels?.[key] ?? {}
        const nodeIdSet = new Set(nodeIds)
        for (const rawNodeId of Object.keys(awakeLevels)) {
            if (!nodeIdSet.has(Number(rawNodeId))) {
                throw new Error(`characterManaNodeAwakeLevels contains unknown node ${characterId}/${rawNodeId}`)
            }
        }
        normalManaNodeSnapshots[key] = new Map(nodeIds.map(nodeId => [nodeId, awakeLevels[nodeId] ?? 0]))

        const explicitAwake = toSerialize.manaBoardAwakeMap?.get(key)
            ?? toSerialize.characterAwakeUnlocks?.[key]
            ?? {}
        const awakeUnlocks = new Map(Object.entries(explicitAwake).map(([boardIndex, awakeLevel]) => [
            Number(boardIndex),
            awakeLevel,
        ]))
        awakeUnlockSnapshots[key] = awakeUnlocks
        visibleManaBoardIndexes.set(
            characterId,
            getCharacterVisibleManaBoardIndex(character.manaBoardIndex, characterId),
        )
        rarityByCharacter.set(characterId, getCharacterDataSync(characterId)?.rarity ?? null)
    }

    const batch = createCharacterGrowthBatchContext({
        playerId: toSerialize.player.id,
        characterIds,
        storedCharactersSnapshot,
        bondTokenSnapshots,
        normalManaNodeSnapshots,
        awakeUnlockSnapshots,
        rarityLoader: characterId => rarityByCharacter.get(characterId) ?? null,
    })
    return projectCharacterGrowthLoad({
        batch,
        characters: toSerialize.characterList,
        visibleManaBoardIndexes,
    })
}


/**
 * Serializes a player data object in the way that the world flipper client expects it.
 * 
 * @param player The player data object to serialize.
 * @returns A serialized player data object.
 */
export function serializePlayerData(
    toSerialize: MergedPlayerData,
    options?: SerializePlayerDataOptions
): ClientPlayerData {
    const growthLoadProjection = projectSerializedCharacterGrowth(toSerialize)

    // convert parties
    const userPartyGroupList: Record<string, UserPartyGroup> = serializePartyGroupList(toSerialize.partyGroupList)

    // convert equipment list
    const userEquipmentList: Record<string, UserEquipment> = {}
    for (const [equipmentId, equipment] of Object.entries(toSerialize.equipmentList)) {
        userEquipmentList[equipmentId] = {
            "enhancement_level": equipment.enhancementLevel,
            "level": equipment.level,
            "protection": equipment.protection,
            "stack": equipment.stack
        }
    }

    // convert player Quest Progress
    const userQuestProgress: Record<string, UserQuestProgress[]> = {}
    for (const [section, progresses] of Object.entries(toSerialize.questProgress)) {
        const list: UserQuestProgress[] = []
        for (const progress of progresses) {
            list.push(serializePlayerQuestProgress(progress))
        }
        userQuestProgress[section] = list
    }

    // convert box gacha list
    const userBoxGachaList: Record<string, UserBoxGacha[]> = {}
    for (const [section, list] of Object.entries(toSerialize.boxGachaList)) {
        userBoxGachaList[section] = list.map(boxGacha => {
            return {
                "box_id": boxGacha.boxId,
                "reset_times": boxGacha.resetTimes,
                "remaining_number": boxGacha.remainingNumber,
                "is_closed": boxGacha.isClosed
            }
        })
    }

    // handle tutorial
    let userTutorial: UserTutorial | null = null
    const playerData = toSerialize.player
    const tutorialStep = playerData.tutorialStep
    if (isStartTutorialActive(tutorialStep, playerData.tutorialSkipFlag)) {
        const activeTutorialStep = tutorialStep as number
        userTutorial = {
            "viewer_id": options?.viewerId ?? 0,
            "tutorial_step": activeTutorialStep,
            "skip_flag": playerData.tutorialSkipFlag
        }

        if (activeTutorialStep >= 1) {
            userTutorial["powerflip_failure"] = 0
        }
    }

    const realTimeStamina = computeRealTimeStamina(playerData)
    if (realTimeStamina !== playerData.stamina) {
        const staminaHealTime = getRealNow()
        updatePlayerSync({ id: playerData.id, stamina: realTimeStamina, staminaHealTime })
        playerData.stamina = realTimeStamina
        playerData.staminaHealTime = staminaHealTime
    }

    const clientData: ClientPlayerData = {
        "user_info": {
            "stamina": playerData.stamina,
            "stamina_heal_time": realToVirtual(playerData.staminaHealTime),
            "boost_point": playerData.boostPoint,
            "boss_boost_point": playerData.bossBoostPoint,
            "transition_state": playerData.transitionState,
            "role": playerData.role,
            "name": playerData.name,
            "last_login_time": clientSerializeDate(playerData.lastLoginTime),
            "comment": playerData.comment,
            "vmoney": playerData.vmoney,
            "free_vmoney": playerData.freeVmoney,
            "rank_point": playerData.rankPoint,
            "star_crumb": playerData.starCrumb,
            "bond_token": playerData.bondToken,
            "exp_pool": playerData.expPool,
            "exp_pooled_time": expPoolRealDateToClientTimestamp(playerData.expPooledTime),
            "leader_character_id": playerData.leaderCharacterId != null ? kIdToBusinessCode(playerData.leaderCharacterId) : 0,
            "party_slot": playerData.partySlot,
            "degree_id": playerData.degreeId,
            "birth": playerData.birth,
            "free_mana": playerData.freeMana,
            "paid_mana": playerData.paidMana,
            "enable_auto_3x": playerData.enableAuto3x
        },
        "premium_bonus_list": [],
        "expired_premium_bonus_list": null,
        "user_daily_challenge_point_list": toSerialize.dailyChallengePointList.map(dailyChallenge => {
            return {
                "id": dailyChallenge.id,
                "point": dailyChallenge.point,
                "campaign_list": dailyChallenge.campaignList.map(campaign => {
                    return {
                        "campaign_id": campaign.campaignId,
                        "additional_point": campaign.additionalPoint
                    }
                })
            }
        }),
        "bonus_index_list": null,
        "login_bonus_received_at": null,
        "user_notice_list": [],
        "user_triggered_tutorial": toSerialize.triggeredTutorial,
        "user_tutorial": userTutorial,
        "tutorial_gacha": toSerialize.player.tutorialGachaCharacterId !== null && toSerialize.player.tutorialGachaCharacterId !== undefined
            ? { character_id: toSerialize.player.tutorialGachaCharacterId }
            : null,
        "cleared_regular_mission_list": toSerialize.clearedRegularMissionList,
        "user_character_list": growthLoadProjection.userCharacterList as unknown as ClientPlayerData["user_character_list"],
        "user_character_mana_node_list": growthLoadProjection.userCharacterManaNodeList as ClientPlayerData["user_character_mana_node_list"],
        "user_party_group_list": userPartyGroupList,
        "item_list": toSerialize.itemList,
        "user_equipment_list": userEquipmentList,
        "user_character_from_town_history": [],
        "quest_progress": userQuestProgress,
        "last_main_quest_id": null,
        "gacha_info_list": toSerialize.gachaInfoList.map(gachaInfo => {
            return {
                "gacha_id": gachaInfo.gachaId,
                "is_daily_first": gachaInfo.isDailyFirst,
                "is_account_first": gachaInfo.isAccountFirst,
                "gacha_exchange_point": gachaInfo.gachaExchangePoint
            }
        }),
        "available_asset_version": resolveSerializedAssetVersion(options?.availableAssetVersion),
        "should_prompt_takeover_registration": false,
        "has_unread_news_item": false,
        "user_option": toSerialize.userOption,
        "drawn_quest_list": toSerialize.drawnQuestList.map(drawnQuest => {
            return {
                "category_id": drawnQuest.categoryId,
                "quest_id": drawnQuest.questId,
                "odds_id": drawnQuest.oddsId
            }
        }),
        "mail_arrived": getPlayerMailCountSync(toSerialize.player.id, true) > 0,
        "user_periodic_reward_point_list": toSerialize.periodicRewardPointList,
        "all_active_mission_list": toSerialize.allActiveMissionList,
        "cleared_collect_item_event_mission_list": getPlayerClearedCollectItemEventMissionListSync(toSerialize.player.id),
        "box_gacha_list": userBoxGachaList,
        "gacha_campaign_list": toSerialize.gachaCampaignList.map(campaign => serializeGachaCampaign(campaign)),
        "purchased_times_list": {
            "gs.kg.worldflipper.pakage_monthly": 0,
            "gs.kg.worldflipper.pakage_rank": 0,
            "gs.kg.worldflipper.pakage_monthly_90": 0,
            "gs.kg.worldflipper.pakage_monthly_stamina": 0,
            "gs.kg.worldflipper.pakage_monthly_kareido": 0,
            "gs.kg.worldflipper.pakage_monthly_boss": 0,
            "gs.kg.worldflipper.pakage_rank_2": 0,
            "gs.kg.worldflipper.pakage_rank_3_1": 0,
            "gs.kg.worldflipper.pakage_rank_4": 0,
            "gs.kg.worldflipper.pakage_challenge_boost": 0
        },
        "start_dash_exchange_campaign_list": toSerialize.startDashExchangeCampaignList.map(campaign => {
            return {
                "campaign_id": campaign.campaignId,
                "gacha_id": campaign.gachaId,
                "period_start_time": getServerTime(campaign.periodStartTime),
                "period_end_time": getServerTime(campaign.periodEndTime),
                "status": campaign.status,
                "term_index": campaign.termIndex
            }
        }),
        "multi_special_exchange_campaign_list": toSerialize.multiSpecialExchangeCampaignList.map(campaign => {
            return {
                "campaign_id": campaign.campaignId,
                "status": campaign.status
            }
        }),
        "associate_token": "associate_token",
        "config": {
            "summon_com_seconds": options?.summonComSeconds ?? 5,
            "attention_recruitment_interval_seconds": 15,
            "attention_recruitment_redeliver_limit": 20,
            "attention_polling_interval_seconds_normal": 10,
            "attention_polling_interval_seconds_battle": 15,
            "multi_attention_lifetime_seconds": 30,
            "contribution_score_rate_to_parasite": 0.25,
            "attention_log_interval_seconds": 600,
            "disable_finish_duration_seconds": 5,
            "disable_decline_count_seconds": 60,
            "disable_decline_count_limit": 14,
            "disable_decline_duration_seconds": 30,
            "disable_intent_disconnect_duration_seconds": 300,
            "disable_unintent_disconnect_duration_seconds": 5,
            "disable_remote_error_duration_seconds": 300,
            "attention_animation_time_seconds": 6,
            "disable_expire_count_limit": 4,
            "disable_expire_duration_seconds": 180,
            "polling_delay_normal_seconds_range_min": 1,
            "polling_delay_normal_seconds_range_max": 10,
            "polling_delay_battle_seconds_range_min": 1,
            "polling_delay_battle_seconds_range_max": 15,
            "return_attention_max_num": 3
        }
    }

    // add optional values

    // serialize rush event data
    if (options?.serializeRushEventData ?? false) {
        // rush event list
        if (toSerialize.rushEventList !== undefined) {
            const userRushEventList: Record<string, UserRushEvent> = {}
            for (const rushEvent of toSerialize.rushEventList) {
                userRushEventList[rushEvent.eventId] = serializeRushEvent(rushEvent)
            }
            clientData.user_rush_event_list = userRushEventList
        }

        // cleared folder list
        clientData.user_rush_event_cleared_folder_list = toSerialize.rushEventClearedFolderList

        // rush event played party list
        if (toSerialize.rushEventPlayedPartyList !== undefined) {
            const userRushEventPlayedPartyList: UserRushEventPlayedPartyList = {}

            for (const [eventId, parties] of Object.entries(toSerialize.rushEventPlayedPartyList)) {
                const battleTypeBuckets: Record<RushEventBattleType, Record<string, UserRushEventPlayedParty> | undefined> = {
                    [RushEventBattleType.FOLDER]: undefined,
                    [RushEventBattleType.ENDLESS]: undefined
                }
                for (const party of parties) {
                    let bucket = battleTypeBuckets[party.battleType]
                    if (bucket === undefined) {
                        bucket = {}
                        battleTypeBuckets[party.battleType] = bucket
                    }
                    bucket[party.round] = serializePlayerRushEventPlayedParty(party)
                }
                userRushEventPlayedPartyList[eventId] = battleTypeBuckets as Record<RushEventBattleType, Record<string, UserRushEventPlayedParty>>
            }
            clientData.user_rush_event_played_party_list = userRushEventPlayedPartyList
        }
    }

    if (options?.activeMissionList) {
        (clientData as any).active_mission_list = options.activeMissionList
    }

    return clientData
}
