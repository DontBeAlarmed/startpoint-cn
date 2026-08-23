import type { FactKey } from "./facts/fact-key"
import type { MissionFactRequirementRegistry } from "./requirements/types"

const CATEGORY = 9

export function normalizeAwakeCandidateCharacterIds(
    candidateCharacterIds: readonly number[] | undefined,
): readonly number[] | undefined {
    if (candidateCharacterIds === undefined) return undefined
    if (!Array.isArray(candidateCharacterIds)) {
        throw new TypeError("Awake candidateCharacterIds must be an array")
    }
    for (let index = 0; index < candidateCharacterIds.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(candidateCharacterIds, index)) {
            throw new TypeError("Awake candidateCharacterIds array must be complete")
        }
    }
    const normalized = candidateCharacterIds.map(characterId => {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw new TypeError("Awake candidate character IDs must be positive safe integers")
        }
        return characterId
    })
    return Object.freeze([...new Set(normalized)].sort((left, right) => left - right))
}

function isSupportedAwakeFact(fact: FactKey): boolean {
    switch (fact.kind) {
        case "player":
        case "characters":
        case "questProgress":
        case "characterClearCounters":
        case "partyCoClearCounters":
            return true
        case "categoryMissionProgress":
            return fact.category === CATEGORY
        case "characterManaNodes":
        case "characterManaNodeAwakeLevels":
        case "equipment":
        case "items":
        case "missionBattleCounters":
        case "degreeBattleStats":
        case "awakeEligibility":
        case "collectedItems":
        case "partyGroups":
        case "shopPurchases":
        case "periodicSnapshot":
        case "passState":
            return false
        default: {
            const exhaustive: never = fact
            return exhaustive
        }
    }
}

export function collectSupportedAwakeMissionIds(
    missionIds: readonly number[],
    requirementRegistry: MissionFactRequirementRegistry,
): { readonly candidates: readonly number[]; readonly closure: readonly number[] } {
    const evaluated = new Map<number, {
        readonly valid: boolean
        readonly closure: ReadonlySet<number>
    }>()
    const closure = new Set<number>()
    const unsupported = Object.freeze({
        valid: false,
        closure: new Set<number>() as ReadonlySet<number>,
    })
    const visit = (
        missionId: number,
        visiting: Set<number>,
    ): { readonly valid: boolean; readonly closure: ReadonlySet<number> } => {
        const cached = evaluated.get(missionId)
        if (cached !== undefined) return cached
        if (visiting.has(missionId)) return unsupported
        const requirement = requirementRegistry.getRequirement(CATEGORY, missionId)
        if (!requirement || requirement.mode === "unsupported") {
            evaluated.set(missionId, unsupported)
            return unsupported
        }
        const nextVisiting = new Set(visiting).add(missionId)
        const localClosure = new Set<number>()
        let valid = true
        for (const dependency of requirement.missionDependencies) {
            if (dependency.category !== CATEGORY) {
                valid = false
                continue
            }
            const dependencyResult = visit(dependency.missionId, nextVisiting)
            if (!dependencyResult.valid) {
                valid = false
                continue
            }
            for (const dependencyId of dependencyResult.closure) localClosure.add(dependencyId)
        }
        for (const fact of requirement.facts) {
            if (!isSupportedAwakeFact(fact)) {
                valid = false
                continue
            }
            if (fact.kind === "categoryMissionProgress") {
                for (const dependencyId of fact.missionIds) localClosure.add(dependencyId)
            }
        }
        if (!valid) {
            evaluated.set(missionId, unsupported)
            return unsupported
        }
        localClosure.add(missionId)
        const result = Object.freeze({
            valid: true,
            closure: localClosure as ReadonlySet<number>,
        })
        evaluated.set(missionId, result)
        return result
    }
    const candidates = missionIds.filter(missionId => {
        const result = visit(missionId, new Set())
        if (!result.valid) return false
        for (const dependencyId of result.closure) closure.add(dependencyId)
        return true
    })
    return {
        candidates: Object.freeze(candidates),
        closure: Object.freeze([...closure].sort((left, right) => left - right)),
    }
}
