import { getPlayerSingleQuestProgressSync, incrementPlayerQuestMultiClearSync } from "../../data/domains/quest"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings"
import { getAdditionalRewardTable, settleAdditionalRewardsSync } from "../../lib/additional-reward"
import {
    getQuestConfigurationErrorResponse,
    getQuestFromCategorySync,
} from "../../lib/quest-content"
import { getMultiRewardPolicySync } from "../../lib/config-content"
import { givePlayerCharactersExpSync } from "../../lib/character"
import { buildBattleMissionSettlementScopes, recordMissionBattleFacts } from "../../lib/mission/battle-facts"
import {
    getAwakeBattleMissionIds,
    settleAwakeMissionCandidatesWithEvaluation,
    settleMissionCategoriesWithEvaluation,
} from "../../lib/mission"
import { collectAwakeCandidateCharacterIds } from "../../lib/mission/awake-candidate-character-ids"
import { publishActiveMissionOwnerStateWithinTransaction } from "../../lib/mission/active-publication-owner"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication"
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
import { getPeriodicRewardCatalog } from "../../lib/quest/periodic-reward-content"
import { getRewardCampaignTable } from "../../lib/reward-campaign"
import type { FinishContext } from "../../lib/quest/finish/types"
import { resolveHostFinished } from "../../lib/quest/host-finish"
import { validateMultiFinishRequest, type ValidatedMultiFinish } from "../../lib/quest/multi-battle-validation"
import { getCommonScoreRewardCount } from "../../lib/score-reward-lottery"
import { addStaminaWithOverflowCap, getMaxStamina } from "../../lib/stamina"
import { PlayerNotFoundError } from "../../lib/quest/start-entry"
import { QuestCategory, type BattleQuest } from "../../lib/types"
import { formatHardMultiMissionDiagnostic } from "../../lib/mission/client-check-diagnostics"
import { sampledLog } from "../../lib/sampled-log"
import { getRealNow } from "../../runtime/time/game-time"
import {
    recordCompletedMainChapterMilestoneSync,
    recordRank100MilestoneSync,
} from "../../lib/player-history-milestones"
import type { BattleSessionId, ParticipantIdentity } from "../coordinator/contracts"
import type { MultiHttpContext } from "../http/context"
import { MultiSettlementRewardGranter } from "./reward-grant"
import type { MultiFinishBody } from "../types"
import {
    settleRescueFragmentReward,
} from "../rescue-fragment-reward"
import { withEntryItemInventoryWithinTransactionSync } from "../../lib/quest/entry-item-inventory"
import { createMultiSettlementValuePlan } from "./value-plan"
import { writeMultiQuestProgressWithinTransactionSync } from "./quest-progress-write"

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
    readonly authoritativeParticipants: readonly ParticipantIdentity[]
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
            authoritativeParticipants: finalizedBattle.value.participants,
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
    // Validate the complete reward Content closure before opening the write transaction.
    getRewardCampaignTable()
    getAdditionalRewardTable()
    getPeriodicRewardCatalog()
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
        const rewardGranter = new MultiSettlementRewardGranter(input.playerId)
        const freshValidation = validateMultiFinishRequest(
            body as unknown as Record<string, unknown>,
            activeQuest,
            { boostPoint: player.boostPoint, bossBoostPoint: player.bossBoostPoint },
        )
        if (!freshValidation.ok) throw new ActiveQuestSettlementConflictError()
        const questProgress = getPlayerSingleQuestProgressSync(input.playerId, questCategory, questId)
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
                withEntryItemInventory: withEntryItemInventoryWithinTransactionSync,
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
        const fieldMana = freshValidation.addMana
        const { settlementTime, valuePlan } = createMultiSettlementValuePlan({
            player,
            activeQuest,
            quest: questData,
            questCategory,
            questId,
            questAccomplished,
            fieldMana,
            maxComboCount: Number((freshValidation.statistics as any).max_combo_count ?? 0),
        })
        const {
            beforeRankPoint,
            newRankPoint,
            oldDegreeId,
            newDegreeId,
            didLevelUp,
            fixedManaReward,
            fixedPoolExpReward,
            characterBattleExp,
            manaObtained,
            playerValues,
            rewardCampaignRates,
        } = valuePlan
        const {
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint,
        } = playerValues
        if (oldDegreeId < 100 && newDegreeId >= 100) {
            recordRank100MilestoneSync(input.playerId, newRankPoint)
        }
        finishCtx.manaObtained = manaObtained
        updatePlayerSync({
            id: input.playerId,
            ...playerValues,
            ...(didLevelUp
                ? {
                    stamina: addStaminaWithOverflowCap(player.stamina, getMaxStamina(newDegreeId)),
                    staminaHealTime: getRealNow(),
                }
                : {}),
        })
        const clearReward = rewardEligibility.firstClear && (questData as any).clearReward !== undefined
            ? rewardGranter.grantReward((questData as any).clearReward)
            : null
        const sPlusClearReward = rewardEligibility.sPlus && (questData as any).sPlusReward !== undefined
            ? rewardGranter.grantReward((questData as any).sPlusReward)
            : null

        const questProgressWritten = writeMultiQuestProgressWithinTransactionSync({
            playerId: input.playerId,
            questCategory,
            questAccomplished,
            questId,
            clearTime,
            score: freshValidation.score,
            clearRank,
            leaderCharacterId: leaderId ?? null,
            hostFinished,
            existing: questProgress,
        })
        if (questProgressWritten) {
            if (questCategory === QuestCategory.MAIN) {
                recordCompletedMainChapterMilestoneSync(input.playerId, questId)
            }
        }

        const scoreRewardsResult = questAccomplished
            ? rewardGranter.grantScoreRewards(
                questData.scoreRewardGroupId || 0,
                questData.scoreRewardGroup,
                useBoostPoint,
                questData.element,
                {
                    commonRewardCount: getCommonScoreRewardCount(
                        questData,
                        clearRank,
                        getMultiRewardPolicySync().commonRewardMultiplier,
                    ) ?? undefined,
                    rewardCampaignRates,
                    rewardDate: settlementTime,
                },
            )
            : rewardGranter.grantScoreRewards()
        const serverDropMultiplier = getServerGameplaySettingsSync().dropMultiplier
        const additionalRewardSettlement = questAccomplished
            ? settleAdditionalRewardsSync(
                getAdditionalRewardTable(),
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
                { grantRewards: rewards => rewardGranter.grantRewards(rewards) },
            )
            : { dropAdditionalRewardIds: [], rewardResult: null }
        const rescueFragmentSettlement = settleRescueFragmentReward({
            eligible: storedQuest.rescueFragmentEligible === true,
            questAccomplished,
            questCategory,
            questId,
        }, rewards => rewardGranter.grantRewards([...rewards]))
        const periodicRewardSettlement = settleActivityPeriodicRewardsSync({
            playerId: input.playerId,
            questCategory,
            questId,
            questAccomplished,
            isMulti: true,
        })
        const missionBattleFacts = recordMissionBattleFacts(finishCtx, settlementTime)
        // Quest-domain multi-clear counter lives with the quest finish writer,
        // not inside the mission fact recorder (D24 writer convergence).
        if (questAccomplished) {
            incrementPlayerQuestMultiClearSync(input.playerId, questCategory, questId)
        }
        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            input.playerId,
            partyCharacterIdsArray,
            characterBattleExp,
            questData.fixedParty !== undefined,
            undefined,
            settlementTime,
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
                undefined,
                {},
                { claimStageRewards: false },
            )
            : null
        const awakeMissionSettlement = awakeMissionEvaluation?.settlement ?? {
            missionInfo: [], itemList: {}, characterList: [], equipmentList: [],
            degreeIds: [], passCardPoints: {},
        }
        const playerData = getPlayerSync(input.playerId)
        if (playerData === null) throw new PlayerNotFoundError(input.playerId)
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
            ...rewardGranter.invalidatedFactKeys,
            ...(manaObtained > 0 ? [{ kind: "player" as const }] : []),
            ...(questAccomplished
                && questCategory === QuestCategory.CHARACTER
                && !questPreviouslyCompleted
                ? [{ kind: "questProgress" as const, sections: [QuestCategory.CHARACTER] }]
                : []),
        ]
        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            input.playerId,
            candidateCharacterIds,
            [existingCharacterList],
            {
                invalidatedFactKeys,
                directMissionIds: [
                    ...missionBattleFacts.awakeMissionIds,
                    ...(awakeMissionEvaluation?.evaluation.missions.map(mission => mission.missionId) ?? []),
                ],
                ...(awakeMissionEvaluation === null ? {} : {
                    evaluatedAwakeUnlocks: {
                        progressList: awakeMissionEvaluation.evaluation.missions.map(mission => ({
                            missionId: mission.missionId,
                            progress: mission.finalProgress,
                        })),
                        resolver: awakeMissionEvaluation.resolver,
                    },
                }),
            },
            "multi-finish",
            settlementTime,
        ).characterList
        const activeMission = publishActiveMissionOwnerStateWithinTransaction({
            playerId: input.playerId,
            now: settlementTime,
            source: "multi-finish",
        })
        return {
            characterList,
            activeMissionList: activeMission.activeMissionList,
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
            fieldMana: valuePlan.fieldMana,
            fixedManaReward,
            fixedPoolExpReward,
            degreeId: playerData.degreeId,
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
