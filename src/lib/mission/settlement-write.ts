import {
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} from "../../data/domains/mission"
import { MissionRewardGranter } from "./grants"
import { getMissionMasterDefinition } from "./master-data"
import { getCategoryMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers } from "./stages"
import type {
    MissionEvaluationResult,
    MissionSettlementInfo,
    MissionSettlementObserver,
    MissionSettlementResult,
} from "./settlement"

export function settleMissionEvaluation(
    evaluation: MissionEvaluationResult,
    observer?: MissionSettlementObserver,
): MissionSettlementResult {
    const granter = new MissionRewardGranter(evaluation.playerId, evaluation.player)
    const missionInfo: MissionSettlementInfo[] = []

    for (const mission of evaluation.missions) {
        if (mission.finalProgress === mission.dbProgress) continue
        observer?.onMissionProgressChanged?.(mission.category, mission.missionId)
        updatePlayerCategoryMissionSync(
            evaluation.playerId,
            mission.category,
            mission.missionId,
            mission.finalProgress,
        )
    }

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
            updatePlayerCategoryMissionStageSync(
                evaluation.playerId,
                mission.category,
                stage,
                mission.missionId,
                true,
            )
            const passCardEventId = mission.category >= 6 && mission.category <= 8
                ? getMissionMasterDefinition(mission.category, mission.missionId)?.eventId
                : undefined
            granter.grant(definition.rewards, { passCardEventId })
            missionInfo.push({
                mission_category_id: mission.category,
                mission_id: mission.missionId,
                mission_reward_id: definition.missionRewardId,
            })
        }
    }

    granter.persistPlayer()
    return {
        missionInfo,
        itemList: granter.itemList,
        characterList: granter.characterList,
        equipmentList: granter.equipmentList,
        degreeIds: granter.degreeList,
        passCardPoints: granter.passCardPoints,
        ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
    }
}
