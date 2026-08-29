import type { PlayerQuestProgress } from "../../../data/types"
import {
    getQuestConfigurationErrorResponse,
    getQuestFromCategorySync,
    getRushEventFolderMaxRoundSync,
    getRushEventQuestConfigurationErrorResponse,
    getScoreAttackBorderRewards,
} from "../../assets"
import { QuestCategory, type BattleQuest } from "../../types"
import { activeQuests, type ActiveQuest } from "../active-quest-service"
import {
    DailyChallengePointExhaustedError,
    DailyChallengePointUnavailableError,
} from "../daily-challenge"
import { resolveQuestRewardEligibility } from "../first-clear-reward"
import {
    runSingleFinishSettlementTransaction,
    SingleFinishSettlementValidationError,
} from "../single-finish-settlement"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"
import { calculateClearRank } from "./quest-calc"
import {
    calculateScoreAttackClearRank,
    resolveScoreAttackBorderTiers,
    type ScoreAttackBorderTier,
} from "./score-attack-handler"
import type { FinishContext } from "./types"
import {
    executeSingleSettlementWrites,
    type SingleSettlementWritesResult,
} from "./single-settlement-writes"
import { recordScoreRewardSettlement } from "../score-reward-settlement"

export interface SingleFinishFailure {
    ok: false
    statusCode: 400 | 500
    payload: Record<string, unknown>
}

export type SingleFinishSuccess = SingleSettlementWritesResult & {
    ok: true
    body: ValidatedSingleFinishBody
    clearRank: number | null
    questProgress: PlayerQuestProgress | null
}

export type SingleFinishResult = SingleFinishFailure | SingleFinishSuccess

function failure(
    statusCode: 400 | 500,
    error: string,
    message: string,
): SingleFinishFailure {
    return { ok: false, statusCode, payload: { error, message } }
}

export function settleSingleBattleQuest({
    playerId,
    memoryActiveQuest,
    body,
    dailyResetHour = 5,
}: {
    playerId: number
    memoryActiveQuest: ActiveQuest | undefined
    body: ValidatedSingleFinishBody
    dailyResetHour?: number
}): SingleFinishResult {
    console.log(`[FINISH] req: playerId=${playerId} questId=${body.quest_id} category=${body.category} activeExists=${memoryActiveQuest !== undefined} multi=${memoryActiveQuest?.isMulti ?? false}`)
    if (memoryActiveQuest === undefined) {
        return failure(400, "Bad Request", "No active quest to finish.")
    }

    const questCategory = memoryActiveQuest.category
    const questId = memoryActiveQuest.questId
    console.log(`[FINISH] active: category=${questCategory} questId=${questId}`)
    let questData: BattleQuest | null
    try {
        questData = getQuestFromCategorySync(questCategory, questId)
    } catch (error) {
        const configurationError = getQuestConfigurationErrorResponse(error)
        if (configurationError !== null) {
            return { ok: false, statusCode: 500, payload: configurationError }
        }
        throw error
    }
    if (questData === null || !("rankPointReward" in questData)) {
        console.log(`[BATTLE] finish failed: category=${questCategory} questId=${questId} found=${!!questData} hasRankReward=${questData ? ("rankPointReward" in questData) : "N/A"}`)
        return failure(400, "Bad Request", "Quest doesn't exist.")
    }
    const finishQuest = questData as BattleQuest & { rankPointReward: number }

    let rushEventFolderMaxRound: number | undefined
    if (questCategory === QuestCategory.RUSH_EVENT && finishQuest.rushEventRound !== 0) {
        try {
            rushEventFolderMaxRound = getRushEventFolderMaxRoundSync(
                finishQuest.rushEventId,
                finishQuest.rushEventFolderId,
            )
        } catch (error) {
            const configurationError = getRushEventQuestConfigurationErrorResponse(error)
            if (configurationError !== null) {
                return { ok: false, statusCode: 500, payload: configurationError }
            }
            throw error
        }
    }

    const clearTime = body.elapsed_time_ms
    const isScoreAttackEvent = questCategory === QuestCategory.SCORE_ATTACK_EVENT
    if (isScoreAttackEvent && (
        finishQuest.bRankScore === undefined
        || finishQuest.aRankScore === undefined
        || finishQuest.sRankScore === undefined
        || finishQuest.ssRankScore === undefined
    )) {
        return failure(500, "Internal Server Error", "Score attack rank thresholds are missing.")
    }
    const clearRank = isScoreAttackEvent
        ? calculateScoreAttackClearRank(body.score, {
            bRankScore: finishQuest.bRankScore!,
            aRankScore: finishQuest.aRankScore!,
            sRankScore: finishQuest.sRankScore!,
            ssRankScore: finishQuest.ssRankScore!,
        })
        : calculateClearRank(clearTime, finishQuest)

    let questAccomplished = body.is_accomplished
    let scoreAttackBorderTiers: ScoreAttackBorderTier[] = []
    if (isScoreAttackEvent) {
        try {
            scoreAttackBorderTiers = resolveScoreAttackBorderTiers(
                finishQuest.eventId,
                finishQuest.scoreAttackQuestId,
                getScoreAttackBorderRewards(),
            )
        } catch (error) {
            console.error(`[SCORE_ATTACK] invalid configuration: ${(error as Error).message}`)
            return failure(500, "Internal Server Error", "Score attack reward configuration is missing.")
        }
        questAccomplished = body.score >= scoreAttackBorderTiers[0].score
    }
    let transactionResult: {
        settlement: SingleSettlementWritesResult
        questProgress: PlayerQuestProgress | null
    }
    try {
        transactionResult = runSingleFinishSettlementTransaction({
            playerId,
            memoryQuest: memoryActiveQuest,
            request: {
                playId: body.play_id,
                questId: body.quest_id,
                category: body.category,
                continueCount: body.continue_count,
            },
            settle: ({ activeQuest, player, questProgress }) => {
                const questPreviouslyCompleted = questProgress?.finished === true
                const rewardEligibility = resolveQuestRewardEligibility({
                    questAccomplished,
                    clearRank,
                    questProgress,
                })
                const finishCtx: FinishContext = {
                    playerId,
                    questCategory,
                    questId,
                    questAccomplished,
                    clearTime,
                    clearRank,
                    score: body.score,
                    party: body.statistics.party,
                    statistics: body.statistics,
                    equipmentElements: body.equipment_element,
                    player,
                    questPreviouslyCompleted,
                    questProgress,
                }
                const settlement = executeSingleSettlementWrites({
                    body,
                    questData: finishQuest,
                    rewardEligibility,
                    finishCtx,
                    rushEventFolderMaxRound,
                    scoreAttackBorderTiers,
                    dailyResetHour,
                }, activeQuest, player)
                return { settlement, questProgress }
            },
        })
    } catch (error) {
        if (error instanceof SingleFinishSettlementValidationError) {
            return failure(400, "Bad Request", error.message)
        }
        if (error instanceof DailyChallengePointExhaustedError
            || error instanceof DailyChallengePointUnavailableError) {
            return failure(400, "Bad Request", error.message)
        }
        throw error
    }

    recordScoreRewardSettlement(
        playerId,
        transactionResult.settlement.scoreRewardSelection,
        transactionResult.settlement.scoreRewardsResult,
    )
    delete activeQuests[playerId]
    return {
        ok: true,
        body,
        clearRank,
        questProgress: transactionResult.questProgress,
        ...transactionResult.settlement,
    }
}
