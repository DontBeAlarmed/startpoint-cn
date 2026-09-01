import {
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} from "../../data/domains/mission"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { AwakeMissionInfo, AwakeMissionSettlementResult } from "./awake-settlement"
import { MissionRewardGranter } from "./grants"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCharacterIdFromMission } from "./character-queries"
import { getCompletedStageNumbers } from "./stages"
import { getFactKeyId, normalizeFactKey, type FactKey } from "./facts/fact-key"
import type { MissionEvaluationResult, MissionSettlementObserver } from "./settlement"
import type { MissionSettlementRewardDependencies } from "./settlement-write"

export interface AwakeMissionEvaluationSettlement {
    readonly settlement: AwakeMissionSettlementResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

export function settleAwakeMissionEvaluation(
    evaluation: MissionEvaluationResult,
    resolver: CharacterAwakeEligibilityResolver,
    observer?: MissionSettlementObserver,
): AwakeMissionSettlementResult {
    return settleAwakeMissionEvaluationWithInvalidations(evaluation, resolver, observer).settlement
}

export function settleAwakeMissionEvaluationWithInvalidations(
    evaluation: MissionEvaluationResult,
    resolver: CharacterAwakeEligibilityResolver,
    observer?: MissionSettlementObserver,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionEvaluationSettlement {
    const missions = evaluation.missions.filter(mission => (
        mission.category === 9
        && resolver.isNewUnlockEligible(
            Number(getCharacterIdFromMission(mission.missionId)),
            mission.missionId,
        )
    ))
    const granter = new MissionRewardGranter(evaluation.playerId, evaluation.player)
    const missionInfo: AwakeMissionInfo[] = []
    let awakeEligibilityChanged = false

    for (const mission of missions) {
        if (mission.finalProgress === mission.dbProgress) continue
        observer?.onMissionProgressChanged?.(9, mission.missionId)
        updatePlayerCategoryMissionSync(
            evaluation.playerId,
            9,
            mission.missionId,
            mission.finalProgress,
        )
    }

    for (const mission of missions) {
        for (const stage of getCompletedStageNumbers(9, mission.missionId, mission.finalProgress)) {
            if (mission.receivedStages.includes(stage)) continue
            const definition = getAwakeMissionRewardStageDefinition(mission.missionId, stage)
            if (!definition) continue
            updatePlayerCategoryMissionStageSync(
                evaluation.playerId,
                9,
                stage,
                mission.missionId,
                true,
            )
            granter.grant(definition.rewards, {
                definitionId: definition.missionRewardId,
                standardRewardGrant: dependencies.standardRewardGrant,
            })
            missionInfo.push({
                mission_category_id: 9,
                mission_id: mission.missionId,
                mission_reward_id: definition.missionRewardId,
            })
            if (!definition.specialReward) continue
            // The mission engine records the reward receipt only. Permanent
            // CharacterAwake state is published by Character Growth after the
            // outer owner has finished producing all mission facts.
            awakeEligibilityChanged = true
        }
    }

    granter.persistPlayer()
    const invalidatedFacts = new Map(granter.invalidatedFactKeys.map(key => [
        getFactKeyId(key),
        key,
    ]))
    if (awakeEligibilityChanged) {
        const key = normalizeFactKey({ kind: "awakeEligibility" })
        invalidatedFacts.set(getFactKeyId(key), key)
    }
    return Object.freeze({
        settlement: {
            missionInfo,
            itemList: granter.itemList,
            characterList: granter.characterList as Record<string, unknown>[],
            equipmentList: granter.equipmentList,
            degreeIds: granter.degreeList,
            passCardPoints: {},
            ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
        },
        invalidatedFactKeys: Object.freeze([...invalidatedFacts.values()]),
    })
}
