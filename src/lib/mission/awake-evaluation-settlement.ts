import { upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import {
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} from "../../data/domains/mission"
import { buildManaBoardAwakeCharacterList } from "../character-helpers"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { AwakeMissionInfo, AwakeMissionSettlementResult } from "./awake-settlement"
import { MissionRewardGranter } from "./grants"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCharacterIdFromMission } from "./character-queries"
import { getCompletedStageNumbers } from "./stages"
import { getFactKeyId, normalizeFactKey, type FactKey } from "./facts/fact-key"
import type { MissionEvaluationResult, MissionSettlementObserver } from "./settlement"

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
    const unlockMap = new Map<string, Record<number, number>>()
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
            granter.grant(definition.rewards)
            missionInfo.push({
                mission_category_id: 9,
                mission_id: mission.missionId,
                mission_reward_id: definition.missionRewardId,
            })
            if (!definition.specialReward) continue
            const special = definition.specialReward
            if (!upsertPlayerCharacterAwakeUnlockSync(
                evaluation.playerId,
                special.characterId,
                special.boardIndex,
                special.awakeLevel,
            )) continue
            awakeEligibilityChanged = true
            const levels = unlockMap.get(String(special.characterId)) ?? {}
            levels[special.boardIndex] = Math.max(
                levels[special.boardIndex] ?? 0,
                special.awakeLevel,
            )
            unlockMap.set(String(special.characterId), levels)
        }
    }

    granter.persistPlayer()
    const characterList = [
        ...(granter.characterList as Record<string, unknown>[]),
        ...buildManaBoardAwakeCharacterList(resolver.characters, unlockMap),
    ]
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
            characterList,
            equipmentList: granter.equipmentList,
            degreeIds: granter.degreeList,
            passCardPoints: {},
            ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
        },
        invalidatedFactKeys: Object.freeze([...invalidatedFacts.values()]),
    })
}
