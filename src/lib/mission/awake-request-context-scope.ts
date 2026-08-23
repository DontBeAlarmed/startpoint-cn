import { getFactKeyId, normalizeFactKey, type FactKey } from "./facts/fact-key"
import type { MissionFactRequirementRegistry } from "./requirements/types"

const CATEGORY = 9

// Keep one scoped IN query comfortably below SQLite's 32766-variable limit.
// The co-clear reader repeats the IDs for its two IN clauses, so the context
// budget is intentionally lower than the per-reader ceiling.
export const MAX_SCOPED_CHARACTER_IDS = 10000

export interface AwakeMissionSeeds {
    readonly invalidatedFactKeys?: readonly FactKey[]
    readonly directMissionIds?: readonly number[]
}

export interface AwakePublicationScope extends AwakeMissionSeeds {
    readonly candidateCharacterIds: readonly number[]
}

function assertCompleteArray(value: unknown, field: string): asserts value is readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`Awake ${field} must be an array`)
    }
    for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError(`Awake ${field} array must be complete`)
        }
    }
}

export function normalizeAwakeInvalidatedFactKeys(
    invalidatedFactKeys: readonly FactKey[] | undefined,
): readonly FactKey[] {
    if (invalidatedFactKeys === undefined) return Object.freeze([])
    assertCompleteArray(invalidatedFactKeys, "invalidatedFactKeys")
    const normalized = new Map<string, FactKey>()
    for (const fact of invalidatedFactKeys) {
        const normalizedFact = normalizeFactKey(fact)
        normalized.set(getFactKeyId(normalizedFact), normalizedFact)
    }
    return Object.freeze([...normalized.values()])
}

export function normalizeAwakeDirectMissionIds(
    directMissionIds: readonly number[] | undefined,
): readonly number[] {
    if (directMissionIds === undefined) return Object.freeze([])
    assertCompleteArray(directMissionIds, "directMissionIds")
    const normalized = new Set<number>()
    for (const missionId of directMissionIds) {
        if (!Number.isSafeInteger(missionId) || missionId <= 0) {
            throw new TypeError("Awake direct mission IDs must be positive safe integers")
        }
        normalized.add(missionId)
    }
    return Object.freeze([...normalized].sort((left, right) => left - right))
}

export function collectAwakeMissionIdsFromSeeds(
    seeds: AwakeMissionSeeds,
    requirementRegistry: MissionFactRequirementRegistry,
): readonly number[] {
    const missionIds = new Set(normalizeAwakeDirectMissionIds(seeds.directMissionIds))
    for (const fact of normalizeAwakeInvalidatedFactKeys(seeds.invalidatedFactKeys)) {
        for (const ref of requirementRegistry.getMissionsForFact(fact)) {
            if (ref.category === CATEGORY) missionIds.add(ref.missionId)
        }
    }
    let addedParent = true
    while (addedParent) {
        addedParent = false
        for (const entry of requirementRegistry.entries) {
            if (entry.category !== CATEGORY || missionIds.has(entry.missionId)) continue
            const hasSelectedDependency = entry.requirement.missionDependencies.some(
                dependency => dependency.category === CATEGORY
                    && missionIds.has(dependency.missionId),
            )
            if (hasSelectedDependency) {
                missionIds.add(entry.missionId)
                addedParent = true
            }
        }
    }
    return Object.freeze([...missionIds].sort((left, right) => left - right))
}

function normalizeScopedCharacterIds(ids: readonly number[]): number[] {
    const normalized = new Set<number>()
    for (const characterId of ids) {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw new TypeError("Awake scoped character IDs must be positive safe integers")
        }
        normalized.add(characterId)
    }
    return [...normalized].sort((left, right) => left - right)
}

function assertAwakeScopedCharacterIdBudget(characterIds: readonly number[]): void {
    if (characterIds.length > MAX_SCOPED_CHARACTER_IDS) {
        throw new RangeError(
            "Awake candidate scope exceeds bounded character-id budget "
                + `(max ${MAX_SCOPED_CHARACTER_IDS})`,
        )
    }
}

export function mergeAwakeScopedCharacterIds(
    candidateCharacterIds: readonly number[],
    existingUnlockCharacterIds: readonly number[],
): readonly number[] {
    const merged = normalizeScopedCharacterIds([
        ...candidateCharacterIds,
        ...existingUnlockCharacterIds,
    ])
    assertAwakeScopedCharacterIdBudget(merged)
    return Object.freeze(merged)
}

export function normalizeAwakeCandidateCharacterIds(
    candidateCharacterIds: readonly number[] | undefined,
): readonly number[] | undefined {
    if (candidateCharacterIds === undefined) return undefined
    assertCompleteArray(candidateCharacterIds, "candidateCharacterIds")
    const normalized = candidateCharacterIds.map(characterId => {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw new TypeError("Awake candidate character IDs must be positive safe integers")
        }
        return characterId
    })
    const normalizedUnique = [...new Set(normalized)].sort((left, right) => left - right)
    assertAwakeScopedCharacterIdBudget(normalizedUnique)
    return Object.freeze(normalizedUnique)
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
