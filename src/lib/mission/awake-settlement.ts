import { getDb } from "../../data/db"
import { createCharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import { getMissionCatalog, MissionCatalog } from "./mission-catalog"
import {
    prepareMissionSettlement,
    selectMissionSettlementCandidates,
} from "./settlement-prepare"
import { evaluateMissionCandidates } from "./settlement-evaluate"
import {
    settleAwakeMissionEvaluationWithInvalidations,
} from "./awake-evaluation-settlement"
import type {
    MissionEvaluationResult,
    PreparedMissionSettlement,
} from "./settlement"
import type { FactKey } from "./facts/fact-key"
import type { PlannedItemOverflowDisposition } from "../item-overflow"
import type { MissionSettlementRewardDependencies } from "./settlement-write"

export interface AwakeMissionComputedProgress {
    missionId: number
    progress: number
}

export interface AwakeMissionInfo {
    mission_category_id: 9
    mission_id: number
    mission_reward_id: number
}

export interface AwakeMissionSettlementResult {
    missionInfo: AwakeMissionInfo[]
    itemList: Record<string, number>
    characterList: Record<string, unknown>[]
    equipmentList: Object[]
    degreeIds: number[]
    passCardPoints: Record<string, number>
    userInfo?: Record<string, number>
    itemOverflowDispositions?: readonly PlannedItemOverflowDisposition[]
}

export interface AwakeMissionSettlementEvaluation {
    readonly prepared: PreparedMissionSettlement
    readonly evaluation: MissionEvaluationResult
    readonly resolver: CharacterAwakeEligibilityResolver
    readonly settlement: AwakeMissionSettlementResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

export interface AwakeBattleMissionSettlementParams {
    readonly playerId: number
    readonly questAccomplished: boolean
    readonly characterIds: readonly number[]
    readonly directlyChangedMissionIds: readonly number[]
    readonly evaluationTime: Date
}

function emptyAwakeMissionSettlement(): AwakeMissionSettlementResult {
    return {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    }
}

export function getAwakeBattleMissionIds(
    characterIds: readonly number[],
    directlyChangedMissionIds: readonly number[] = [],
    catalog: MissionCatalog = getMissionCatalog(),
): number[] {
    const characterIdSet = new Set(characterIds.filter(characterId =>
        Number.isSafeInteger(characterId) && characterId > 0,
    ))
    const candidates = [...characterIdSet]
        .flatMap(characterId => catalog.getAwakeMissionIdsByCharacter(characterId))
    for (const missionId of directlyChangedMissionIds) {
        if (Number.isSafeInteger(missionId)
            && missionId > 0
            && catalog.getDefinition(9, missionId) !== undefined) {
            candidates.push(missionId)
        }
    }
    return [...new Set(candidates)].sort((left, right) => left - right)
}

export function settleAwakeMissionCandidates(
    playerId: number,
    missionIds: readonly number[],
    evaluationTime: Date,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionSettlementResult {
    return settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        missionIds,
        evaluationTime,
        undefined,
        dependencies,
    )
        ?.settlement ?? emptyAwakeMissionSettlement()
}

export function settleAwakeMissionCandidatesWithEvaluation(
    playerId: number,
    missionIds: readonly number[],
    evaluationTime: Date,
    resolver?: CharacterAwakeEligibilityResolver,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionSettlementEvaluation | null {
    if (missionIds.length === 0) return null
    const candidates = getAwakeBattleMissionIds([], missionIds)
    if (candidates.length === 0) return null
    const categories = [{ category: 9, missionIds: candidates }]
    const selection = selectMissionSettlementCandidates(categories, evaluationTime)
    if (selection.candidates.length === 0) return null
    return getDb().transaction(() => {
        const prepared = prepareMissionSettlement(
            playerId,
            categories,
            evaluationTime,
            undefined,
            selection,
        )
        const evaluation = evaluateMissionCandidates(prepared)
        const effectiveResolver = resolver
            ?? createCharacterAwakeEligibilityResolver(playerId, evaluationTime)
        const settled = settleAwakeMissionEvaluationWithInvalidations(
            evaluation,
            effectiveResolver,
            undefined,
            dependencies,
        )
        return {
            prepared,
            evaluation,
            resolver: effectiveResolver,
            settlement: settled.settlement,
            invalidatedFactKeys: settled.invalidatedFactKeys,
        }
    })()
}
