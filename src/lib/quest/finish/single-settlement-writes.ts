import { deletePlayerActiveQuestSync } from "../../../data/domains/quest_active"
import { updatePlayerSync } from "../../../data/domains/player"
import { getPlayerItemSync } from "../../../data/domains/item"
import { getServerGameplaySettingsSync } from "../../../data/domains/server-settings"
import { getPlayerSingleQuestProgressSync } from "../../../data/domains/quest"
import { getPlayerEquipmentListSync } from "../../../data/domains/equipment"
import { recordCompletedMainChapterMilestoneSync, recordRank100MilestoneSync } from "../../player-history-milestones"
import { insertPlayerPracticeBattleHistorySync } from "../../../data/domains/practice-battle-history"
import type { Player } from "../../../data/types"
import { givePlayerCharactersExpSync } from "../../character"
import { getCommonScoreRewardCount } from "../../score-reward-lottery"
import { QuestCategory } from "../../types"
import { addStaminaWithOverflowCap, getMaxStamina } from "../../stamina"
import { getAdditionalRewardTable, settleAdditionalRewardsSync } from "../../additional-reward"
import { recordMissionBattleFacts } from "../../mission/battle-facts"
import { buildPracticeBattleHistoryRecord } from "../practice-battle-history"
import type { ActiveQuest } from "../active-quest-service"
import { getRealNow } from "../../../runtime/time/game-time"
import type { FinishContext, SingleSettlementWritesInput } from "./types"
import { selectScoreRewardGrantPlan } from "../score-reward-selection"
import { grantSingleSettlementScoreRewardsWithinTransactionSync } from "./single-settlement-reward-grant"
import { createSingleSettlementStandardRewardGrant } from "./single-standard-reward-callbacks"
import { createSingleSettlementResponseState } from "./single-settlement-response-state"
import { createRewardGrantItemOverflowPolicy } from "../../reward-grant-item-overflow"
import {
    prepareSingleGrowthPublication,
    publishPreparedSingleGrowthPublication,
} from "./single-growth-publication"
import { settleSingleEntryResources } from "./single-entry-resource-settlement"
import { writeSingleQuestProgressWithinTransactionSync } from "./single-quest-progress-write"
import { createSingleSettlementValuePlan } from "./single-settlement-value-plan"
import { createEventSettlementDescriptor } from "./event-settlement-descriptor"
import { settleSingleBuiltInEvent } from "./single-event-settlement"
import { resolveRushFinalOperationOverrideForSettings } from "../../rush-final-operation-policy"

export function executeSingleSettlementWrites(
    input: SingleSettlementWritesInput,
    settlementActiveQuest: ActiveQuest,
    settlementPlayer: Player,
) {
    const { body, questData, rewardEligibility, finishCtx,
        rushEventFolderMaxRound, scoreAttackBorderTiers, dailyResetHour = 5 } = input
    const { playerId, questCategory, questId, clearTime, clearRank,
        questAccomplished, questProgress, questPreviouslyCompleted } = finishCtx
    const isScoreAttackEvent = questCategory === QuestCategory.SCORE_ATTACK_EVENT
    const party = body.statistics.party
    const leaderId = party.characters[0]?.id
    const partyCharacterIds: number[] = []
    for (const value of [...party.characters, ...party.unison_characters]) {
        const characterId = value?.id
        if (typeof characterId === "number"
            && Number.isSafeInteger(characterId)
            && characterId > 0) partyCharacterIds.push(characterId)
    }
    const { settlementTime, valuePlan } = createSingleSettlementValuePlan({
        player: settlementPlayer,
        activeQuest: settlementActiveQuest,
        quest: questData,
        body,
        questAccomplished,
    })
    const {
        beforeRankPoint,
        newRankPoint,
        oldDegreeId,
        newDegreeId,
        didLevelUp,
        fixedManaReward,
        fixedPoolExpReward,
        fieldMana,
        characterBattleExp,
        manaObtained,
        playerValues,
        useBoostPoint,
        rewardCampaignRates,
    } = valuePlan
    const {
        freeMana: newMana,
        expPool: newExpPool,
        boostPoint: newBoostPoint,
        bossBoostPoint: newBossBoostPoint,
    } = playerValues
    finishCtx.manaObtained = manaObtained
    const entryResourceResult = settleSingleEntryResources({
        playerId,
        activeQuest: settlementActiveQuest,
        questAccomplished,
        dailyResetHour,
    })
    settlementPlayer.totalStaminaUsed += entryResourceResult.staminaUsed
    const rewardGrantOptions = { itemOverflow: createRewardGrantItemOverflowPolicy(playerId, settlementTime) }
    const responseState = createSingleSettlementResponseState(playerId, settlementPlayer, rewardGrantOptions)
    const grantDirectRewards = responseState.grant
    const standardRewardGrant = createSingleSettlementStandardRewardGrant(
        playerId,
        responseState.setPlayerState,
        responseState.observeGrant,
        rewardGrantOptions,
    )

    const questProgressWritten = writeSingleQuestProgressWithinTransactionSync({
        playerId,
        questCategory,
        questAccomplished: questAccomplished && !isScoreAttackEvent,
        questId,
        clearTime,
        score: body.score,
        clearRank,
        leaderCharacterId: leaderId ?? undefined,
        existing: questProgress,
    })
    if (questProgressWritten) {
        if (questCategory === QuestCategory.MAIN) recordCompletedMainChapterMilestoneSync(playerId, questId)
    }
    if (oldDegreeId < 100 && newDegreeId >= 100) recordRank100MilestoneSync(playerId, newRankPoint)
    const releasedEntryResources = entryResourceResult.kind === "released"
        ? entryResourceResult : null
    const staminaBeforeRankRefill = releasedEntryResources?.afterStamina ?? settlementPlayer.stamina
    const afterStamina = didLevelUp
        ? addStaminaWithOverflowCap(staminaBeforeRankRefill, getMaxStamina(newDegreeId))
        : staminaBeforeRankRefill
    const afterStaminaHealTime = releasedEntryResources
        ? releasedEntryResources.afterStaminaHealTime
        : didLevelUp ? getRealNow() : settlementPlayer.staminaHealTime
    updatePlayerSync({
        id: playerId,
        ...playerValues,
        ...(didLevelUp ? { stamina: afterStamina, staminaHealTime: afterStaminaHealTime } : {}),
    })
    responseState.setPlayerState({
        playerId: responseState.playerState.playerId,
        freeMana: playerValues.freeMana,
        freeVmoney: responseState.playerState.freeVmoney,
        expPool: newExpPool,
    })
    const clearReward = !isScoreAttackEvent && rewardEligibility.firstClear && questData.clearReward !== undefined
        ? grantDirectRewards(playerId, [questData.clearReward]) : null
    const sPlusClearReward = !isScoreAttackEvent && rewardEligibility.sPlus && questData.sPlusReward !== undefined
        ? grantDirectRewards(playerId, [questData.sPlusReward]) : null

    const dailyChallengePointList = entryResourceResult.kind === "committed"
        ? entryResourceResult.dailyChallengePointList : null
    const eventDescriptor = createEventSettlementDescriptor({
        questCategory,
        questId,
        quest: questData,
        activeEventId: settlementActiveQuest.eventId ?? undefined,
    })
    const gameplaySettings = questAccomplished || eventDescriptor.kind === "rush"
        ? getServerGameplaySettingsSync()
        : null
    const scoreRewardSelection = questAccomplished
        ? selectScoreRewardGrantPlan(
            questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.element, {
                commonRewardCount: getCommonScoreRewardCount(questData, clearRank) ?? undefined,
                rewardCampaignRates, rewardDate: settlementTime,
            },
        )
        : selectScoreRewardGrantPlan()
    const scoreRewardGrant = grantSingleSettlementScoreRewardsWithinTransactionSync(
        playerId, scoreRewardSelection, responseState.playerState, rewardGrantOptions,
    )
    responseState.observeGrant(scoreRewardGrant.grant)
    const scoreRewardsResult = scoreRewardGrant.result
    const additionalRewardSettlement = questAccomplished
        ? settleAdditionalRewardsSync(
            getAdditionalRewardTable(),
            {
                questCategory, questId, enemyLevel: questData.enemyLevel,
                nowMs: settlementTime.getTime(), isMulti: false,
                isQuestCleared: (category, requiredQuestId) => (
                    getPlayerSingleQuestProgressSync(playerId, category, requiredQuestId)?.finished === true
                ),
                rewardCampaignRates, boostPointUsed: useBoostPoint,
                serverDropMultiplier: gameplaySettings!.dropMultiplier,
            },
            { grantRewards: rewards => grantDirectRewards(playerId, rewards) },
        )
        : { dropAdditionalRewardIds: [], rewardResult: null }
    const missionBattleFacts = recordMissionBattleFacts(finishCtx, settlementTime)
    const rewardCharacterExpResult = givePlayerCharactersExpSync(
        playerId,
        partyCharacterIds,
        characterBattleExp,
        questData.fixedParty !== undefined,
        responseState.playerState.expPool,
        settlementTime,
    )
    responseState.setExpPool(rewardCharacterExpResult.exp_pool)

    const {
        rushEventData,
        rushEventRewardsResult,
        raidEventData,
        carnivalEventData,
        carnivalRewardResult,
        scoreAttackFinishResult,
        scoreAttackRewardResult,
    } = settleSingleBuiltInEvent({
        descriptor: eventDescriptor,
        playerId,
        body,
        activeQuest: settlementActiveQuest,
        questData,
        clearRank,
        settlementTime,
        rushEventFolderMaxRound,
        scoreAttackBorderTiers,
        rushFolderRewardOverride: eventDescriptor.kind === "rush"
            ? resolveRushFinalOperationOverrideForSettings(gameplaySettings!)
            : null,
        grantRewards: grantDirectRewards,
        standardRewardGrant,
    })
    responseState.observeItems(carnivalRewardResult?.item_list)
    if (questCategory === QuestCategory.PRACTICE) insertPlayerPracticeBattleHistorySync(buildPracticeBattleHistoryRecord({
        playerId, playId: settlementActiveQuest.playId, categoryId: questCategory, questId,
        finishKind: questAccomplished ? 0 : 1, createdAt: settlementTime,
        elapsedTimeMs: clearTime, score: body.score, clearRank: questAccomplished ? clearRank : null,
        party, statistics: body.statistics, equipmentList: getPlayerEquipmentListSync(playerId),
    }))
    const preparedGrowthPublication = prepareSingleGrowthPublication({
        playerId, partyCharacterIds, evaluationTime: settlementTime, questAccomplished,
        directAwakeMissionIds: missionBattleFacts.awakeMissionIds,
        directDegreeMissionIds: missionBattleFacts.degreeMissionIds,
        rewardDependencies: { standardRewardGrant: standardRewardGrant.forMission },
        rewardInvalidatedFactKeys: responseState.rewardInvalidatedFactKeys,
        characterLists: [
            rewardCharacterExpResult.character_list as unknown as Record<string, unknown>[],
            (clearReward?.character_list || []) as Record<string, unknown>[],
            (sPlusClearReward?.character_list || []) as Record<string, unknown>[],
            scoreRewardsResult.character_list as Record<string, unknown>[],
            (scoreAttackRewardResult?.character_list ?? []) as Record<string, unknown>[],
        ],
        manaObtained, questCategory, questPreviouslyCompleted,
    })
    const {
        missionSettlement,
        awakeMissionSettlement,
        activeMissionList,
    } = preparedGrowthPublication
    responseState.observeResult(missionSettlement)
    responseState.observeResult(awakeMissionSettlement)
    if (settlementActiveQuest.entryItemId) {
        responseState.observeItems({
            [settlementActiveQuest.entryItemId]: getPlayerItemSync(playerId,
                settlementActiveQuest.entryItemId) ?? 0,
        })
    }
    const { itemList, itemOverflowDispositions, finalPlayerProjection } = responseState.finalize({
        rankPoint: newRankPoint, stamina: afterStamina, staminaHealTime: afterStaminaHealTime,
        boostPoint: newBoostPoint, bossBoostPoint: newBossBoostPoint,
    })
    if (!isScoreAttackEvent) deletePlayerActiveQuestSync(playerId)
    const characterList = publishPreparedSingleGrowthPublication({
        playerId, partyCharacterIds, evaluationTime: settlementTime,
        publication: preparedGrowthPublication.publication,
    })
    return {
        afterStamina, afterStaminaHealTime, dailyChallengePointList,
        scoreRewardSelection, scoreRewardsResult, additionalRewardSettlement,
        rewardCharacterExpResult, rushEventData, rushEventRewardsResult,
        raidEventData, carnivalEventData, carnivalRewardResult, scoreAttackFinishResult,
        scoreAttackRewardResult, itemList, characterList, clearReward, sPlusClearReward,
        missionSettlement, awakeMissionSettlement, activeMissionList, fixedManaReward,
        fixedPoolExpReward, fieldMana, newMana, beforeRankPoint, newRankPoint, newBoostPoint,
        newBossBoostPoint, finalPlayerProjection,
        itemOverflowDispositions,
    }
}
export type SingleSettlementWritesResult = ReturnType<typeof executeSingleSettlementWrites>
