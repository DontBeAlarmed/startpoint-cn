import { getFactKeyId, normalizeFactKey, type FactIdSelection, type FactKey } from "./facts/fact-key"
import { getMissionCatalog } from "./mission-catalog"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import type { MissionFactRequirementRegistry, MissionRef } from "./requirements/types"
import { evaluateMissionCandidates } from "./settlement-evaluate"
import type {
    EvaluatedMissionResult,
    MissionEvaluationResult,
    MissionSettlementEvaluation,
} from "./settlement"

function missionKey(ref: MissionRef): string {
    return `${ref.category}:${ref.missionId}`
}

function compareRefs(left: MissionRef, right: MissionRef): number {
    return left.category - right.category || left.missionId - right.missionId
}

function selectionsIntersect(left: FactIdSelection, right: FactIdSelection): boolean {
    if (left === "all" || right === "all") return true
    const rightValues = new Set(right)
    return left.some(value => rightValues.has(value))
}

function factKeysIntersect(left: FactKey, right: FactKey): boolean {
    const normalizedLeft = normalizeFactKey(left)
    const normalizedRight = normalizeFactKey(right)
    if (normalizedLeft.kind !== normalizedRight.kind) return false

    if (normalizedLeft.kind === "collectedItems" && normalizedRight.kind === "collectedItems") {
        return selectionsIntersect(normalizedLeft.itemIds, normalizedRight.itemIds)
    }
    if (normalizedLeft.kind === "questProgress" && normalizedRight.kind === "questProgress") {
        return selectionsIntersect(normalizedLeft.sections, normalizedRight.sections)
    }
    if (normalizedLeft.kind === "categoryMissionProgress"
        && normalizedRight.kind === "categoryMissionProgress") {
        return normalizedLeft.category === normalizedRight.category
            && selectionsIntersect(normalizedLeft.missionIds, normalizedRight.missionIds)
    }
    return getFactKeyId(normalizedLeft) === getFactKeyId(normalizedRight)
}

export function getMissionProgressStageBRefs(
    stageAMissions: readonly EvaluatedMissionResult[],
    invalidatedFactKeys: readonly FactKey[],
    requirementRegistry: MissionFactRequirementRegistry,
): readonly MissionRef[] {
    if (stageAMissions.length === 0 || invalidatedFactKeys.length === 0) {
        return Object.freeze([])
    }

    const requested = new Map<string, EvaluatedMissionResult>()
    for (const mission of stageAMissions) {
        requested.set(missionKey(mission), mission)
    }

    const selected = new Map<string, MissionRef>()
    for (const fact of invalidatedFactKeys) {
        for (const ref of requirementRegistry.getMissionsForFact(fact)) {
            const requestedMission = requested.get(missionKey(ref))
            if (!requestedMission || !requestedMission.declaredFactDependencies.some(dependency => (
                factKeysIntersect(dependency, fact)
            ))) continue
            selected.set(missionKey(ref), Object.freeze({
                category: requestedMission.category,
                missionId: requestedMission.missionId,
            }))
        }
    }

    return Object.freeze([...selected.values()].sort(compareRefs).map(ref => Object.freeze(ref)))
}

export function evaluateMissionProgressStageB(
    stageA: MissionSettlementEvaluation,
): MissionEvaluationResult | null {
    if (stageA.evaluation.missions.length === 0 || stageA.invalidatedFactKeys.length === 0) {
        return null
    }
    const refs = getMissionProgressStageBRefs(
        stageA.evaluation.missions,
        stageA.invalidatedFactKeys,
        getMissionFactRequirementRegistry(getMissionCatalog()),
    )
    if (refs.length === 0) return null

    const refIds = new Set(refs.map(missionKey))
    const scopes = Object.freeze(stageA.prepared.scopes.map(scope => Object.freeze({
        ...scope,
        enabledMissionIds: Object.freeze(scope.enabledMissionIds.filter(missionId => (
            refIds.has(`${scope.category}:${missionId}`)
        ))),
    })))
    const candidates = Object.freeze(refs.map(ref => Object.freeze({
        category: ref.category,
        missionId: ref.missionId,
    })))

    return evaluateMissionCandidates(Object.freeze({
        ...stageA.prepared,
        scopes,
        candidates,
    }))
}
