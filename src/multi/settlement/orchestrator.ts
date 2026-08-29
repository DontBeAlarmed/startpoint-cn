import bundledAdditionalRewardRules from "../../../assets/additional_reward_rules.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import { getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"
import { settleAdditionalRewardsSync, type AdditionalRewardTable } from "../../lib/additional-reward"
import {
    getConfigSync,
    getQuestConfigurationErrorResponse,
    getQuestFromCategorySync,
} from "../../lib/assets"
import { givePlayerCharactersExpSync } from "../../lib/character"
import { buildBattleMissionSettlementScopes, recordMissionBattleFacts } from "../../lib/mission/battle-facts"
import {
    getAwakeBattleMissionIds,
    reconcileAwakeUnlockCharacterListBestEffort,
    settleAwakeMissionCandidatesWithEvaluation,
    settleMissionCategoriesWithEvaluation,
} from "../../lib/mission"
import { collectAwakeCandidateCharacterIds } from "../../lib/mission/awake-candidate-character-ids"
import { createAwakeRequestContextBestEffort } from "../../lib/mission/awake-best-effort-context"
import { getAwakeFactKeysFromLegacyRewardResults } from "../../lib/mission/awake-reward-facts"
import type { FactKey } from "../../lib/mission/facts/fact-key"
import {
    ActiveQuestSettlementConflictError,
    activeQuests,
    runMultiActiveQuestSettlementTransaction,
    type ActiveQuest,
} from "../../lib/quest/active-quest-service"
import {
    commitEntryResources,
    computeEntryLifecycleStamina,
    releaseEntryResources,
    type ReleaseEntryResourcesResult,
} from "../../lib/quest/entry-lifecycle"
import { resolveQuestRewardEligibility } from "../../lib/quest/first-clear-reward"
import { settleActivityPeriodicRewardsSync } from "../../lib/quest/finish/periodic-reward-handler"
import type { FinishContext } from "../../lib/quest/finish/types"
import { resolveHostFinished } from "../../lib/quest/host-finish"
import { validateMultiFinishRequest, type ValidatedMultiFinish } from "../../lib/quest/multi-battle-validation"
import { givePlayerRewardSync, givePlayerRewardsSync, givePlayerScoreRewardsSync } from "../../lib/quest"
import {
    calculateCharacterBattleExp,
    calculateFixedQuestMana,
    calculateFixedQuestPoolExp,
    getRewardCampaignRates,
} from "../../lib/reward-campaign"
import { getCommonScoreRewardCount } from "../../lib/score-reward-lottery"
import { addStaminaWithOverflowCap, getMaxStamina, getRankDegree } from "../../lib/stamina"
import { getPlayerItemSync, setPlayerItemSync } from "../../data/domains/item"
import { PlayerNotFoundError } from "../../lib/quest/start-entry"
import { QuestCategory, type BattleQuest } from "../../lib/types"
import { formatHardMultiMissionDiagnostic } from "../../lib/mission/client-check-diagnostics"
import { sampledLog } from "../../lib/sampled-log"
import { getServerTime } from "../../utils"
import { getRealNow } from "../../runtime/time/game-time"
import {
    recordCompletedMainChapterMilestoneSync,
    recordRank100MilestoneSync,
} from "../../lib/player-history-milestones"
import type { BattleSessionId } from "../coordinator/contracts"
import type { MultiHttpContext } from "../http/context"
import type { MultiFinishBody } from "../types"
import {
    settleRescueFragmentReward,
} from "../rescue-fragment-reward"

export interface MultiplayerSettlementPreparationInput {
    readonly body: MultiFinishBody
    readonly context: MultiHttpContext
    readonly playerId: number
    readonly viewerId: number
}

export type MultiplayerSettlementPreparation =
    | { readonly ok: true; readonly value: MultiplayerSettlementInput }
    | {
        readonly ok: false
        readonly statusCode: 400 | 500
        readonly response: Record<string, unknown>
    }

export interface MultiplayerSettlementInput {
    readonly activeQuest: ActiveQuest & {
        coordinatorOrigin: "local" | "remote"
        roomNumber: string
        battleSessionId: string
    }
    readonly body: MultiFinishBody
    readonly finishValidation: ValidatedMultiFinish
    readonly isRoomHost: boolean
    readonly playerId: number
    readonly questData: BattleQuest
}

function finalizeMultiAwakePublicationWrites(deleteActiveQuest?: () => void): void {
    deleteActiveQuest?.()
}

export async function prepareMultiplayerSettlement(
    input: MultiplayerSettlementPreparationInput,
): Promise<MultiplayerSettlementPreparation> {
    const { body, context, playerId, viewerId } = input
    const activeQuest = activeQuests[playerId]
    if (activeQuest === undefined) {
        return badRequest("No active quest to finish.")
    }

    let questData: BattleQuest | null
    try {
        questData = getQuestFromCategorySync(activeQuest.category, activeQuest.questId)
    } catch (error) {
        const configurationError = getQuestConfigurationErrorResponse(error)
        if (configurationError !== null) {
            return { ok: false, statusCode: 500, response: configurationError }
        }
        throw error
    }
    if (questData === null || !("rankPointReward" in questData)) {
        return badRequest("Quest doesn't exist.")
    }

    const finishValidation = validateMultiFinishRequest(
        body as unknown as Record<string, unknown>,
        activeQuest,
    )
    if (!finishValidation.ok) return badRequest(finishValidation.message)

    if (typeof activeQuest.roomNumber !== "string"
        || typeof activeQuest.battleSessionId !== "string"
        || (activeQuest.coordinatorOrigin !== "remote"
            && activeQuest.coordinatorOrigin !== "local")) {
        return badRequest("Battle session identity or coordinator origin is missing.")
    }

    const participant = context.snapshotProvider.getParticipant(viewerId)
    const verification = await context.settlementVerifier.verify({
        nodeSessionId: participant.nodeSessionId,
        viewerId,
        roomNumber: activeQuest.roomNumber,
        battleSessionId: activeQuest.battleSessionId,
        coordinatorOrigin: activeQuest.coordinatorOrigin,
    })
    if (!verification.ok) return badRequest("Battle is not finalized.")

    const finalizedBattle = await context.coordinator.finalizeBattle({
        participant,
        roomNumber: activeQuest.roomNumber,
        battleSessionId: activeQuest.battleSessionId as BattleSessionId,
    })
    if (!finalizedBattle.ok || !finalizedBattle.value.finalized) {
        return badRequest("Battle finalization is unavailable.")
    }

    return {
        ok: true,
        value: {
            activeQuest: activeQuest as MultiplayerSettlementInput["activeQuest"],
            body,
            finishValidation,
            isRoomHost: verification.isHost,
            playerId,
            questData,
        },
    }
}

function badRequest(message: string): MultiplayerSettlementPreparation {
    return {
        ok: false,
        statusCode: 400,
        response: { error: "Bad Request", message },
    }
}

export function runMultiplayerSettlementOrchestration(input: MultiplayerSettlementInput) {
    const { activeQuest, body, finishValidation, isRoomHost, questData } = input
    const questCategory = activeQuest.category
    const questId = activeQuest.questId
    const clearTime = finishValidation.elapsedTimeMs
    const hasRankThresholds = questData.bRankTime > 0
    const clearRank = hasRankThresholds ? (
        questData.sPlusRankTime >= clearTime ? 5
            : questData.sRankTime >= clearTime ? 4
                : questData.aRankTime >= clearTime ? 3
                    : questData.bRankTime >= clearTime ? 2
                        : 1
    ) : null

    if (questCategory === 26) {
        sampledLog("hard-multi-mission-diagnostic", () =>
            formatHardMultiMissionDiagnostic({
                category: questCategory,
                questId,
                accomplished: body.is_accomplished,
                clearRank,
                clearTimeMs: clearTime,
                statistics: finishValidation.statistics,
            })!
        )
    }

    const useBoostPoint = activeQuest.useBoostPoint || activeQuest.useBossBoostPoint
    const questAccomplished = body.is_accomplished
    const leaderId = (finishValidation.statistics as any).party?.characters?.[0]?.id
    const bodyPartyStatistics = (finishValidation.statistics as any).party
        || { characters: [], unison_characters: [] }
    const partyCharacterIdsArray: number[] = []
    for (const value of [
        ...(bodyPartyStatistics.characters || []),
        ...(bodyPartyStatistics.unison_characters || []),
    ]) {
        const characterId = value?.id
        if (typeof characterId === "number"
            && Number.isSafeInteger(characterId)
            && characterId > 0) partyCharacterIdsArray.push(characterId)
    }

    const executeFinishWrites = (
        deleteActiveQuest: () => void,
        storedQuest: ActiveQuest,
    ) => {
        const player = getPlayerSync(input.playerId)
        if (!player) throw new PlayerNotFoundError(input.playerId)
        const freshValidation = validateMultiFinishRequest(
            body as unknown as Record<string, unknown>,
            activeQuest,
            { boostPoint: player.boostPoint, bossBoostPoint: player.bossBoostPoint },
        )
        if (!freshValidation.ok) throw new ActiveQuestSettlementConflictError()
        const beforeRankPoint = player.rankPoint
        const newRankPoint = beforeRankPoint + questData.rankPointReward
        const newBoostPoint = player.boostPoint - (activeQuest.useBoostPoint ? 1 : 0)
        const newBossBoostPoint = player.bossBoostPoint - (activeQuest.useBossBoostPoint ? 1 : 0)
        const questProgress = getPlayerSingleQuestProgressSync(input.playerId, questCategory, questId)
        const questProgressExists = questProgress !== null
        const questPreviouslyCompleted = questProgress?.finished === true
        const hostFinished = resolveHostFinished({
            previouslyHostFinished: questProgress?.hostFinished ?? false,
            questAccomplished,
            isRoomHost,
        })
        const rewardEligibility = resolveQuestRewardEligibility({
            questAccomplished,
            clearRank,
            questProgress,
        })
        const oldRkDegree = getRankDegree(beforeRankPoint)
        const newDegreeId = getRankDegree(newRankPoint)
        if (getRankDegree(player.rankPoint) < 100 && newDegreeId >= 100) {
            recordRank100MilestoneSync(input.playerId, newRankPoint)
        }
        const didLevelUp = newDegreeId > oldRkDegree
        const entryResourceResult = questAccomplished
            ? commitEntryResources({
                playerId: input.playerId,
                activeQuest: storedQuest,
            }, {
                getPlayer: getPlayerSync,
                updatePlayer: updatePlayerSync,
                refreshDailyChallengePoints: () => {},
                getDailyChallengePointEntries: () => [],
                updateDailyChallengePoint: () => {},
            })
            : releaseEntryResources({
                playerId: input.playerId,
                activeQuest: storedQuest,
                now: getRealNow(),
            }, {
                getPlayer: getPlayerSync,
                computeStamina: computeEntryLifecycleStamina,
                updatePlayer: updatePlayerSync,
                getItemCount: getPlayerItemSync,
                setItemCount: setPlayerItemSync,
                deleteActiveQuest,
            })
        player.totalStaminaUsed = (player.totalStaminaUsed ?? 0) + entryResourceResult.staminaUsed
        const releasedEntryResources = questAccomplished
            ? null
            : entryResourceResult as ReleaseEntryResourcesResult
        if (releasedEntryResources) {
            player.stamina = releasedEntryResources.afterStamina
            player.staminaHealTime = releasedEntryResources.afterStaminaHealTime
        }
        const finishCtx: FinishContext = {
            playerId: input.playerId,
            questCategory,
            questId,
            questAccomplished,
            clearTime,
            clearRank,
            score: freshValidation.score,
            party: bodyPartyStatistics as any,
            statistics: freshValidation.statistics as any,
            equipmentElements: (body as any).equipment_element,
            player,
            questPreviouslyCompleted,
            questProgress,
            isMulti: true,
            isMultiHost: isRoomHost,
        }
        const settlementTime = new Date(getServerTime() * 1000)
        const rewardCampaignRates = getRewardCampaignRates(questCategory, questId, settlementTime)
        const fixedManaReward = calculateFixedQuestMana(
            questData.manaReward,
            rewardCampaignRates,
            useBoostPoint,
        )
        const fixedPoolExpReward = calculateFixedQuestPoolExp(
            questData.poolExpReward,
            rewardCampaignRates,
            useBoostPoint,
        )
        const characterBattleExp = calculateCharacterBattleExp(
            questData.characterExpReward || 0,
            rewardCampaignRates,
        )
        const fieldMana = freshValidation.addMana
        const newMana = player.freeMana + fixedManaReward + fieldMana
        const manaObtained = fixedManaReward + fieldMana
        finishCtx.manaObtained = manaObtained
        const clearReward = rewardEligibility.firstClear && (questData as any).clearReward !== undefined
            ? givePlayerRewardSync(input.playerId, (questData as any).clearReward)
            : null
        const sPlusClearReward = rewardEligibility.sPlus && (questData as any).sPlusReward !== undefined
            ? givePlayerRewardSync(input.playerId, (questData as any).sPlusReward)
            : null

        if (questAccomplished) {
            if (questProgressExists) {
                const updateData: any = {
                    questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs == null
                        ? clearTime
                        : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    highScore: questProgress.highScore === undefined
                        ? freshValidation.score
                        : Math.max(freshValidation.score, questProgress.highScore),
                    leaderCharacterId: leaderId ?? null,
                    hostFinished,
                }
                if (clearRank !== null) {
                    updateData.clearRank = questProgress.clearRank === undefined
                        ? clearRank
                        : Math.max(clearRank, questProgress.clearRank)
                }
                updatePlayerQuestProgressSync(input.playerId, questCategory, updateData)
            } else {
                insertPlayerQuestProgressSync(input.playerId, questCategory, {
                    questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    highScore: freshValidation.score,
                    clearRank: clearRank ?? 5,
                    leaderCharacterId: leaderId ?? null,
                    hostFinished,
                })
            }
            if (questCategory === QuestCategory.MAIN) {
                recordCompletedMainChapterMilestoneSync(input.playerId, questId)
            }
        }

        updatePlayerSync({
            id: input.playerId,
            freeMana: newMana,
            expPool: player.expPool + fixedPoolExpReward,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint,
            totalManaObtained: (player.totalManaObtained ?? 0) + manaObtained,
            maxComboAchieved: Math.max(
                player.maxComboAchieved ?? 0,
                (freshValidation.statistics as any).max_combo_count ?? 0,
            ),
            ...(didLevelUp
                ? {
                    stamina: addStaminaWithOverflowCap(player.stamina, getMaxStamina(newDegreeId)),
                    staminaHealTime: getRealNow(),
                }
                : {}),
        })
        const playerData = { ...player }
        if (didLevelUp) {
            playerData.stamina = addStaminaWithOverflowCap(playerData.stamina, getMaxStamina(newDegreeId))
            playerData.staminaHealTime = getRealNow()
        }

        const scoreRewardsResult = givePlayerScoreRewardsSync(
            input.playerId,
            questData.scoreRewardGroupId || 0,
            questData.scoreRewardGroup,
            useBoostPoint,
            questData.element,
            {
                commonRewardCount: getCommonScoreRewardCount(
                    questData,
                    clearRank,
                    getConfigSync().common_reward_multiplier_by_multi_play_mode,
                ) ?? undefined,
                rewardCampaignRates,
                rewardDate: settlementTime,
            },
        )
        const serverDropMultiplier = getServerGameplaySettingsSync().dropMultiplier
        const additionalRewardSettlement = questAccomplished
            ? settleAdditionalRewardsSync(
                getRuntimeContentTableSync(
                    "additional_reward_rules.json",
                    bundledAdditionalRewardRules as AdditionalRewardTable,
                ),
                {
                    questCategory,
                    questId,
                    enemyLevel: questData.enemyLevel,
                    nowMs: settlementTime.getTime(),
                    isMulti: true,
                    isQuestCleared: (category, requiredQuestId) => (
                        getPlayerSingleQuestProgressSync(
                            input.playerId,
                            category,
                            requiredQuestId,
                        )?.finished === true
                    ),
                    rewardCampaignRates,
                    boostPointUsed: useBoostPoint,
                    serverDropMultiplier,
                },
                { grantRewards: rewards => givePlayerRewardsSync(input.playerId, rewards) },
            )
            : { dropAdditionalRewardIds: [], rewardResult: null }
        const rescueFragmentSettlement = settleRescueFragmentReward({
            eligible: storedQuest.rescueFragmentEligible === true,
            questAccomplished,
            questCategory,
            questId,
        }, rewards => givePlayerRewardsSync(input.playerId, [...rewards]))
        const periodicRewardSettlement = settleActivityPeriodicRewardsSync({
            playerId: input.playerId,
            questCategory,
            questId,
            questAccomplished,
            isMulti: true,
        })
        const missionBattleFacts = recordMissionBattleFacts(finishCtx, settlementTime)
        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            input.playerId,
            partyCharacterIdsArray,
            characterBattleExp,
            questData.fixedParty !== undefined,
        )
        const missionEvaluation = settleMissionCategoriesWithEvaluation(
            input.playerId,
            buildBattleMissionSettlementScopes(
                partyCharacterIdsArray,
                missionBattleFacts.degreeMissionIds,
            ),
            settlementTime,
        )
        const missionSettlement = missionEvaluation?.settlement ?? {
            missionInfo: [], itemList: {}, characterList: [], equipmentList: [],
            degreeIds: [], passCardPoints: {},
        }
        const awakeMissionEvaluation = questAccomplished
            ? settleAwakeMissionCandidatesWithEvaluation(
                input.playerId,
                getAwakeBattleMissionIds(
                    partyCharacterIdsArray,
                    missionBattleFacts.awakeMissionIds,
                ),
                settlementTime,
            )
            : null
        const awakeMissionSettlement = awakeMissionEvaluation?.settlement ?? {
            missionInfo: [], itemList: {}, characterList: [], equipmentList: [],
            degreeIds: [], passCardPoints: {},
        }
        finalizeMultiAwakePublicationWrites(deleteActiveQuest)
        const existingCharacterList = [
            ...rewardCharacterExpResult.character_list as unknown as Record<string, unknown>[],
            ...((clearReward?.character_list || []) as Record<string, unknown>[]),
            ...((sPlusClearReward?.character_list || []) as Record<string, unknown>[]),
            ...(scoreRewardsResult.character_list as Record<string, unknown>[]),
            ...(missionSettlement.characterList as Record<string, unknown>[]),
            ...awakeMissionSettlement.characterList,
        ]
        const candidateCharacterIds = collectAwakeCandidateCharacterIds(
            partyCharacterIdsArray,
            [existingCharacterList],
        )
        const invalidatedFactKeys: FactKey[] = [
            ...(missionEvaluation?.invalidatedFactKeys ?? []),
            ...(awakeMissionEvaluation?.invalidatedFactKeys ?? []),
            ...getAwakeFactKeysFromLegacyRewardResults(
                clearReward,
                sPlusClearReward,
                scoreRewardsResult,
                additionalRewardSettlement.rewardResult,
            ),
            ...(manaObtained > 0 ? [{ kind: "player" as const }] : []),
            ...(questAccomplished
                && questCategory === QuestCategory.CHARACTER
                && !questPreviouslyCompleted
                ? [{ kind: "questProgress" as const, sections: [QuestCategory.CHARACTER] }]
                : []),
        ]
        const awakeContext = createAwakeRequestContextBestEffort(
            input.playerId,
            candidateCharacterIds,
            { invalidatedFactKeys },
        )
        const characterList = awakeContext === null
            ? existingCharacterList
            : reconcileAwakeUnlockCharacterListBestEffort(
                input.playerId,
                existingCharacterList,
                { context: awakeContext },
            )
        return {
            characterList,
            clearReward,
            playerData,
            rewardCharacterExpResult,
            scoreRewardsResult,
            additionalRewardSettlement,
            rescueFragmentSettlement,
            periodicRewardSettlement,
            sPlusClearReward,
            missionSettlement,
            awakeMissionSettlement,
            fieldMana,
            fixedManaReward,
            fixedPoolExpReward,
            newMana,
            beforeRankPoint,
            newRankPoint,
            newBoostPoint,
            newBossBoostPoint,
            hostFinished,
            oldHighScore: questProgress?.highScore ?? 0,
        }
    }

    const writes = runMultiActiveQuestSettlementTransaction(
        input.playerId,
        {
            playId: activeQuest.playId,
            questId: activeQuest.questId,
            category: activeQuest.category,
            isMulti: true,
            coordinatorOrigin: activeQuest.coordinatorOrigin,
            roomNumber: activeQuest.roomNumber,
            battleSessionId: activeQuest.battleSessionId,
            useBossBoostPoint: activeQuest.useBossBoostPoint,
            useBoostPoint: activeQuest.useBoostPoint,
            continueCount: activeQuest.continueCount,
        },
        executeFinishWrites,
    )
    delete activeQuests[input.playerId]
    return { ...writes, clearRank, questCategory }
}

export type MultiplayerSettlementResult = ReturnType<typeof runMultiplayerSettlementOrchestration>
