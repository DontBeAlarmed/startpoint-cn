import {
    updatePlayerCategoryMissionStagesSync,
    updatePlayerCategoryMissionsSync,
} from "../../data/domains/mission"
import { MissionRewardGranter, type MissionRewardGrantContext } from "./grants"
import { getMissionMasterDefinition } from "./master-data"
import { getCategoryMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers } from "./stages"
import type { FactKey } from "./facts/fact-key"
import type {
    MissionEvaluationResult,
    MissionSettlementInfo,
    MissionSettlementObserver,
    MissionSettlementResult,
} from "./settlement"
import type { ProductionMissionFactSeeds } from "./production-fact-loaders"

export function settleMissionEvaluation(
    evaluation: MissionEvaluationResult,
    observer?: MissionSettlementObserver,
): MissionSettlementResult {
    return settleMissionEvaluationWithInvalidations(evaluation, observer).settlement
}

export interface MissionEvaluationSettlement {
    readonly settlement: MissionSettlementResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

export interface MissionSettlementRewardDependencies {
    readonly standardRewardGrant?: MissionRewardGrantContext["standardRewardGrant"]
    readonly factSeeds?: ProductionMissionFactSeeds
}

export function settleMissionEvaluationWithInvalidations(
    evaluation: MissionEvaluationResult,
    observer?: MissionSettlementObserver,
    dependencies: MissionSettlementRewardDependencies = {},
): MissionEvaluationSettlement {
    const granter = new MissionRewardGranter(evaluation.playerId, evaluation.player)
    const missionInfo: MissionSettlementInfo[] = []

    const progressUpdates = evaluation.missions
        .filter(mission => mission.finalProgress !== mission.dbProgress)
        .map(mission => ({
            category: mission.category,
            missionId: mission.missionId,
            progress: mission.finalProgress,
        }))
    if (progressUpdates.length > 0) {
        for (const mission of evaluation.missions) {
            if (mission.finalProgress !== mission.dbProgress) {
                observer?.onMissionProgressChanged?.(mission.category, mission.missionId)
            }
        }
        updatePlayerCategoryMissionsSync(evaluation.playerId, progressUpdates)
    }

    const stageUpdates: {
        readonly category: number
        readonly stageId: number
        readonly missionId: number
        readonly definition: NonNullable<ReturnType<typeof getCategoryMissionRewardStageDefinition>>
    }[] = []
    for (const mission of evaluation.missions) {
        for (const stage of getCompletedStageNumbers(
            mission.category,
            mission.missionId,
            mission.finalProgress,
        )) {
            if (mission.receivedStages.includes(stage)) continue
            const definition = getCategoryMissionRewardStageDefinition(
                mission.category,
                mission.missionId,
                stage,
            )
            if (!definition) continue
            stageUpdates.push({
                category: mission.category,
                stageId: stage,
                missionId: mission.missionId,
                definition,
            })
        }
    }
    updatePlayerCategoryMissionStagesSync(evaluation.playerId, stageUpdates.map(stage => ({
        category: stage.category,
        stageId: stage.stageId,
        missionId: stage.missionId,
        status: true,
    })))

    for (const stage of stageUpdates) {
        const { category, missionId, definition } = stage
        const passCardEventId = category >= 6 && category <= 8
            ? getMissionMasterDefinition(category, missionId)?.eventId
            : undefined
        granter.grant(definition.rewards, {
            definitionId: definition.missionRewardId,
            passCardEventId,
            standardRewardGrant: dependencies.standardRewardGrant,
        })
        missionInfo.push({
            mission_category_id: category,
            mission_id: missionId,
            mission_reward_id: definition.missionRewardId,
        })
    }

    granter.persistPlayer()
    return {
        settlement: {
            missionInfo,
            itemList: granter.itemList,
            characterList: granter.characterList,
            equipmentList: granter.equipmentList,
            degreeIds: granter.degreeList,
            passCardPoints: granter.passCardPoints,
            ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
        },
        invalidatedFactKeys: granter.invalidatedFactKeys,
    }
}
