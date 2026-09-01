import { serializePlayerData, SerializePlayerDataOptions } from "./serialize-player"
import { getDateFromServerTime, getServerTime, realToVirtual } from "../../utils"
import { ClientPlayerData, DailyChallengePointListEntry, MergedPlayerData, PartyCategory, PlayerBoxGacha, PlayerCharacter, PlayerCharacterBondToken, PlayerDrawnQuest, PlayerEquipment, PlayerGachaCampaign, PlayerGachaInfo, PlayerMultiSpecialExchangeCampaign, PlayerParty, PlayerPartyGroup, PlayerQuestProgress, PlayerRushEvent, PlayerRushEventPlayedParty, PlayerStartDashExchangeCampaign, RushEventBattleType, UserBoxGacha, UserCharacter, UserCharacterBondTokenStatus, UserEquipment, UserGachaCampaign, UserPartyGroup, UserPartyGroupTeam, UserQuestProgress, UserRushEvent, UserRushEventPlayedParty, UserRushEventPlayedPartyList, UserTutorial } from "../types"
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
import { computeAwakeSummary, createAwakeRequestContext, filterToActiveMissions, reconcileAwakeUnlocksFromProgress } from "../../lib/mission/index"
import { reconcileAwakeEvolutionLevelsSync } from "../../lib/mission/awake-evolution-repair"
import { computeManaBoardAwakeFromNodes, mergeManaBoardAwakeMaps } from "../../lib/character-helpers"
import { getDb } from "../db"
import { getCarnivalSaveStateSync } from "../../lib/carnival-save-state"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { getPlayerCharacterAwakeUnlockRecordSync } from "../domains/character_awake"
import { reconcileInterruptedStartTutorialSync } from "../../lib/start-tutorial-state"
import { projectMergedCharacterGrowthState } from "../../lib/character-growth/save/project-growth-state"
export { getDefaultPlayerData } from "./default-player"

export interface GetClientSerializedDataOptions extends SerializePlayerDataOptions {
    readonly activeMissionsOverride?: ReturnType<typeof getPlayerActiveMissionsSync>
    readonly playerOverride?: NonNullable<ReturnType<typeof getPlayerSync>>
}

function restoreActiveMissionPayloadShape(
    missions: ReturnType<typeof getPlayerActiveMissionsSync>,
): ReturnType<typeof getPlayerActiveMissionsSync> {
    return Object.fromEntries(Object.entries(missions).map(([missionId, mission]) => [missionId, {
        ...mission,
        stages: !Array.isArray(mission.stages) && Object.keys(mission.stages).length === 0
            ? []
            : mission.stages,
    }]))
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
    options: GetClientSerializedDataOptions
): ClientPlayerData | null {

    const playerData = reconcileInterruptedStartTutorialSync(playerId, options.playerOverride)
    if (playerData === null) return null

    const doSerializeRushEventData = options.serializeRushEventData ?? false

    // Compute awake mission summary for /load injection
    const awakeContext = createAwakeRequestContext({ playerId })
    const awakeSummary = computeAwakeSummary(playerId, awakeContext)
    awakeSummary.manaBoardAwakeMap = reconcileAwakeUnlocksFromProgress(
        playerId,
        awakeSummary.activeMissionList.map(mission => ({
            missionId: mission.mission_id,
            progress: mission.progress_value,
        })),
        awakeContext.resolver,
        awakeContext,
    ).all

    // The client uses mana_board_awake both to unlock the Awake tab and as the
    // target node-awake level. Keep mission unlocks and persisted node state.
    const awakeEligibility = awakeContext.resolver
    const nodeAwakeLevels = awakeEligibility.manaNodeAwakeLevels
    const manaBoardAwakeMap = mergeManaBoardAwakeMaps(
        awakeSummary.manaBoardAwakeMap,
        computeManaBoardAwakeFromNodes(nodeAwakeLevels)
    )
    const evolutionRepair = reconcileAwakeEvolutionLevelsSync(playerId, {
        characters: awakeEligibility.characters,
        manaNodes: awakeEligibility.manaNodes,
        manaNodeAwakeLevels: nodeAwakeLevels,
    })

    return serializePlayerData({
        player: playerData,
        dailyChallengePointList: getPlayerDailyChallengePointListSync(playerId),
        triggeredTutorial: getPlayerTriggeredTutorialsSync(playerId),
        clearedRegularMissionList: getPlayerClearedRegularMissionListSync(playerId),
        characterList: evolutionRepair.characters,
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
            options.activeMissionsOverride
                ? restoreActiveMissionPayloadShape(options.activeMissionsOverride)
                : getPlayerActiveMissionsSync(playerId),
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
    const growth = projectMergedCharacterGrowthState({
        characterList: getPlayerCharactersSync(playerId),
        characterManaNodeList: getPlayerCharactersManaNodesSync(playerId),
        characterManaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
        characterAwakeUnlocks: getPlayerCharacterAwakeUnlockRecordSync(playerId),
    })

    return {
        player: playerData,
        dailyChallengePointList: getPlayerDailyChallengePointListSync(playerId),
        triggeredTutorial: getPlayerTriggeredTutorialsSync(playerId),
        clearedRegularMissionList: getPlayerClearedRegularMissionListSync(playerId),
        ...growth,
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
