import { serializePlayerData, SerializePlayerDataOptions } from "./serialize-player"
import { getDateFromServerTime, getServerTime, getServerDate, realToVirtual } from "../../utils"
import { ClientPlayerData, DailyChallengePointListEntry, MergedPlayerData, PartyCategory, Player, PlayerBoxGacha, PlayerCharacter, PlayerCharacterBondToken, PlayerDrawnQuest, PlayerEquipment, PlayerGachaCampaign, PlayerGachaInfo, PlayerMultiSpecialExchangeCampaign, PlayerParty, PlayerPartyGroup, PlayerQuestProgress, PlayerRushEvent, PlayerRushEventPlayedParty, PlayerStartDashExchangeCampaign, RushEventBattleType, UserBoxGacha, UserCharacter, UserCharacterBondTokenStatus, UserEquipment, UserGachaCampaign, UserPartyGroup, UserPartyGroupTeam, UserQuestProgress, UserRushEvent, UserRushEventPlayedParty, UserRushEventPlayedPartyList, UserTutorial } from "../types"
import { deserializePlayerRushEventPlayedParty, deserializeRushEvent, getPlayerRushEventListClearedFoldersSync, getPlayerRushEventListPlayedPartiesSync, getPlayerRushEventListSync, serializePlayerRushEventPlayedParty } from "../domains/rushEvent"
import { getPlayerActiveMissionsSync, getPlayerCategoryMissionListSync, getPlayerClearedRegularMissionListSync } from "../domains/mission"
import { getPlayerBoxGachasSync } from "../domains/boxGacha"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync, getPlayerCharactersManaNodeAwakeLevelsSync } from "../domains/character"
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
import { computeAwakeSummary, createCharacterAwakeEligibilityResolver, filterToActiveMissions, reconcileAwakeUnlocksFromProgress } from "../../lib/mission/index"
import { computeManaBoardAwakeFromNodes, mergeManaBoardAwakeMaps } from "../../lib/character-helpers"
import { getDb } from "../db"
import { getCarnivalSaveStateSync } from "../../lib/carnival-save-state"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { getPlayerCharacterAwakeUnlockRecordSync } from "../domains/character_awake"
import { reconcileInterruptedStartTutorialSync } from "../../lib/start-tutorial-state"

/**
 * Generates default player data.
 * 
 * @returns The generated default player data.
 */
export function getDefaultPlayerData(): Omit<Player, 'id'> {
    const now = getServerDate();
    // Default values aligned with CN client PlayerSaveDataTools.createDummy()
    return {
        stamina: 10,
        staminaHealTime: new Date(),
        boostPoint: 10,
        bossBoostPoint: 3,
        transitionState: 0,
        role: 1,
        name: "冒险者",
        lastLoginTime: now,
        comment: "よろしくお願いします",
        vmoney: 100,
        freeVmoney: 100,
        rankPoint: 0,
        starCrumb: 2,
        bondToken: 10,
        expPool: 0,
        expPooledTime: now,
        leaderCharacterId: 1,
        partySlot: 1,
        degreeId: 1,
        birth: 19900101,
        freeMana: 2000,
        paidMana: 2000,
        enableAuto3x: false,
        totalStaminaUsed: 0,
        totalPowerflips: 0,
        totalDashes: 0,
        totalManaObtained: 0,
        maxComboAchieved: 0,
        totalLoginDays: 1,
        tutorialStep: 0,
        tutorialSkipFlag: null,
        tutorialGachaCharacterId: null,
        timeOffset: null
    }
}



/**
 * Takes a playerID and returns all of the necessary data for the game client.
 * 
 * @param playerId 
 * @param viewerId 
 * @returns 
 */
export function getClientSerializedData(
    playerId: number,
    options: SerializePlayerDataOptions
): ClientPlayerData | null {

    reconcileInterruptedStartTutorialSync(playerId)
    const playerData = getPlayerSync(playerId)
    if (playerData === null) return null

    const doSerializeRushEventData = options.serializeRushEventData ?? false

    // Compute awake mission summary for /load injection
    const awakeEligibility = createCharacterAwakeEligibilityResolver(playerId)
    const awakeSummary = computeAwakeSummary(playerId, awakeEligibility)
    awakeSummary.manaBoardAwakeMap = reconcileAwakeUnlocksFromProgress(
        playerId,
        awakeSummary.activeMissionList.map(mission => ({
            missionId: mission.mission_id,
            progress: mission.progress_value,
        })),
        awakeEligibility,
    ).all

    // The client uses mana_board_awake both to unlock the Awake tab and as the
    // target node-awake level. Keep mission unlocks and persisted node state.
    const nodeAwakeLevels = awakeEligibility.manaNodeAwakeLevels
    const manaBoardAwakeMap = mergeManaBoardAwakeMaps(
        awakeSummary.manaBoardAwakeMap,
        computeManaBoardAwakeFromNodes(nodeAwakeLevels)
    )

    return serializePlayerData({
        player: playerData,
        dailyChallengePointList: getPlayerDailyChallengePointListSync(playerId),
        triggeredTutorial: getPlayerTriggeredTutorialsSync(playerId),
        clearedRegularMissionList: getPlayerClearedRegularMissionListSync(playerId),
        characterList: awakeEligibility.characters,
        characterManaNodeList: awakeEligibility.manaNodes,
        characterManaNodeAwakeLevels: nodeAwakeLevels,
        manaBoardAwakeMap,
        partyGroupList: getPlayerPartyGroupListSync(playerId),
        itemList: getPlayerItemsSync(playerId),
        equipmentList: getPlayerEquipmentListSync(playerId),
        questProgress: getPlayerQuestProgressSync(playerId),
        gachaInfoList: getPlayerGachaInfoListSync(playerId),
        gachaCampaignList: getPlayerGachaCampaignListSync(playerId),
        drawnQuestList: getPlayerDrawnQuestsSync(playerId),
        periodicRewardPointList: getPlayerPeriodicRewardPointsSync(playerId),
        allActiveMissionList: filterToActiveMissions(
            getPlayerActiveMissionsSync(playerId),
            getContentSnapshot().repository,
        ),
        boxGachaList: getPlayerBoxGachasSync(playerId),
        purchasedTimesList: {},
        startDashExchangeCampaignList: getPlayerStartDashExchangeCampaignsSync(playerId),
        multiSpecialExchangeCampaignList: getPlayerMultiSpecialExchangeCampaignsSync(playerId),
        userOption: getPlayerOptionsSync(playerId),
        rushEventList: doSerializeRushEventData ? getPlayerRushEventListSync(playerId) : undefined,
        rushEventClearedFolderList: doSerializeRushEventData ? getPlayerRushEventListClearedFoldersSync(playerId) : undefined,
        rushEventPlayedPartyList: doSerializeRushEventData ? getPlayerRushEventListPlayedPartiesSync(playerId) : undefined
    }, {
        ...options,
        activeMissionList: awakeSummary.activeMissionList,
    })
}


/**
 * Assembles a player's full server-side MergedPlayerData (no client serialization).
 * Used by the admin save export/import (snapshot round-trip).
 */
export function getMergedPlayerDataSync(
    playerId: number
): MergedPlayerData | null {
    const playerData = getPlayerSync(playerId)
    if (playerData === null) return null

    return {
        player: playerData,
        dailyChallengePointList: getPlayerDailyChallengePointListSync(playerId),
        triggeredTutorial: getPlayerTriggeredTutorialsSync(playerId),
        clearedRegularMissionList: getPlayerClearedRegularMissionListSync(playerId),
        characterList: getPlayerCharactersSync(playerId),
        characterManaNodeList: getPlayerCharactersManaNodesSync(playerId),
        characterManaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
        characterAwakeUnlocks: getPlayerCharacterAwakeUnlockRecordSync(playerId),
        partyGroupList: getPlayerPartyGroupListSync(playerId),
        itemList: getPlayerItemsSync(playerId),
        equipmentList: getPlayerEquipmentListSync(playerId),
        questProgress: getPlayerQuestProgressSync(playerId),
        gachaInfoList: getPlayerGachaInfoListSync(playerId),
        gachaCampaignList: getPlayerGachaCampaignListSync(playerId),
        drawnQuestList: getPlayerDrawnQuestsSync(playerId),
        periodicRewardPointList: getPlayerPeriodicRewardPointsSync(playerId),
        allActiveMissionList: getPlayerActiveMissionsSync(playerId),
        categoryMissionList: getPlayerCategoryMissionListSync(playerId),
        boxGachaList: getPlayerBoxGachasSync(playerId),
        purchasedTimesList: {},
        startDashExchangeCampaignList: getPlayerStartDashExchangeCampaignsSync(playerId),
        multiSpecialExchangeCampaignList: getPlayerMultiSpecialExchangeCampaignsSync(playerId),
        userOption: getPlayerOptionsSync(playerId),
        rushEventList: getPlayerRushEventListSync(playerId),
        rushEventClearedFolderList: getPlayerRushEventListClearedFoldersSync(playerId),
        rushEventPlayedPartyList: getPlayerRushEventListPlayedPartiesSync(playerId),
        ...getCarnivalSaveStateSync(getDb(), playerId),
    }
}
