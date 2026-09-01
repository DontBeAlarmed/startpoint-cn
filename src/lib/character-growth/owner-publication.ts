import {
    createAwakeRequestContext,
    type AwakeRequestContext,
} from "../mission/awake-request-context"
import { getDb } from "../../data/db"
import { getServerDate } from "../../utils"
import type { AwakeMissionSeeds } from "../mission/awake-request-context-scope"
import { collectAwakeMissionIdsFromSeeds } from "../mission/awake-request-context-scope"
import type { CharacterAwakeEligibilityResolver } from "../mission/awake-eligibility"
import { getMissionCatalog } from "../mission/mission-catalog"
import { getMissionFactRequirementRegistry } from "../mission/requirements/registry"
import type { MissionSettlementResult } from "../mission/settlement"
import {
    publishAwakeUnlockCharacterListWithinTransaction,
    publishEvaluatedAwakeUnlockCharacterListWithinTransaction,
    type AwakeUnlockProgress,
} from "./facts/awake-unlock-facts"
import {
    normalizeCharacterGrowthCandidateIds,
    type CharacterGrowthFactPublication,
} from "./facts/mission-growth-facts"

export interface CharacterGrowthOwnerPublicationResult {
    readonly characterList: Record<string, unknown>[]
    readonly missionSettlement: MissionSettlementResult | null
    readonly growthFacts: readonly CharacterGrowthFactPublication[]
}

export interface EvaluatedAwakeUnlockPublication {
    readonly progressList: readonly AwakeUnlockProgress[]
    readonly resolver: CharacterAwakeEligibilityResolver
}

export interface CharacterGrowthOwnerPublicationScope extends AwakeMissionSeeds {
    readonly evaluatedAwakeUnlocks?: EvaluatedAwakeUnlockPublication
}

function evaluatedAwakeUnlocksCoverScope(
    scope: CharacterGrowthOwnerPublicationScope,
): boolean {
    const evaluated = scope.evaluatedAwakeUnlocks
    if (evaluated === undefined) return false
    const requirements = getMissionFactRequirementRegistry(getMissionCatalog())
    const seededMissionIds = collectAwakeMissionIdsFromSeeds(scope, requirements)
    const evaluatedMissionIds = new Set(evaluated.progressList.map(entry => entry.missionId))
    return seededMissionIds.every(missionId => evaluatedMissionIds.has(missionId))
}

export function createCharacterGrowthPublicationContextBestEffort(
    playerId: number,
    candidateCharacterIds: readonly number[],
    scope: CharacterGrowthOwnerPublicationScope = {},
    evaluationTime?: Date,
): AwakeRequestContext | null {
    try {
        return createAwakeRequestContext({
            playerId,
            candidateCharacterIds,
            evaluationTime,
            invalidatedFactKeys: scope.invalidatedFactKeys,
            directMissionIds: scope.directMissionIds,
        })
    } catch (cause) {
        if (getDb().inTransaction) throw cause
        const error = cause instanceof Error
            ? cause
            : new Error("Unknown Character Growth publication context error")
        console.error("[character-growth] Failed to create publication context.", error)
        return null
    }
}

export function publishCharacterGrowthOwnerStateBestEffort(
    playerId: number,
    explicitCharacterIds: readonly number[],
    characterLists: readonly (readonly Record<string, unknown>[])[],
    scope: CharacterGrowthOwnerPublicationScope,
    source: string,
    evaluationTime?: Date,
): CharacterGrowthOwnerPublicationResult {
    const operationTime = evaluationTime ?? getServerDate()
    const existingCharacterList = characterLists.flatMap(characterList => characterList)
    const candidateCharacterIds = normalizeCharacterGrowthCandidateIds(
        explicitCharacterIds,
        characterLists,
    )
    const useEvaluatedAwakeUnlocks = evaluatedAwakeUnlocksCoverScope(scope)
    const context = !useEvaluatedAwakeUnlocks
        ? createCharacterGrowthPublicationContextBestEffort(
            playerId,
            candidateCharacterIds,
            scope,
            operationTime,
        )
        : null
    let characterList = existingCharacterList
    if (context !== null || useEvaluatedAwakeUnlocks) {
        const publish = () => !useEvaluatedAwakeUnlocks
            ? publishAwakeUnlockCharacterListWithinTransaction(
                playerId,
                existingCharacterList,
                context!,
                scope.directMissionIds?.length
                    ? undefined
                    : candidateCharacterIds.length > 0 ? candidateCharacterIds : undefined,
            )
            : publishEvaluatedAwakeUnlockCharacterListWithinTransaction(
                playerId,
                existingCharacterList,
                scope.evaluatedAwakeUnlocks!.progressList,
                scope.evaluatedAwakeUnlocks!.resolver,
            )
        if (getDb().inTransaction) {
            characterList = publish()
        } else {
            try {
                characterList = getDb().transaction(publish)()
            } catch (cause) {
                const error = cause instanceof Error
                    ? cause
                    : new Error("Unknown Character Growth publication error")
                console.error("[character-growth] Failed to publish owner state.", error)
            }
        }
    }
    return {
        characterList,
        missionSettlement: null,
        growthFacts: [{
            playerId,
            candidateCharacterIds,
            source,
            evaluationTime: operationTime,
            invalidatedFactKeys: scope.invalidatedFactKeys ?? [],
        }],
    }
}
