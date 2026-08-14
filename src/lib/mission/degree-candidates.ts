import {
    getMissionMasterDefinitions,
    type MissionMasterDefinition,
} from "./master-data"

interface DegreeMissionCandidate {
    readonly missionId: number
    readonly targetCharacterId?: number
}

type DegreeConditionIndex = ReadonlyMap<number, readonly DegreeMissionCandidate[]>

const conditionIndexCache = new WeakMap<
    readonly MissionMasterDefinition[],
    DegreeConditionIndex
>()

function getPositiveInteger(value: unknown): number | undefined {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function getConditionIndex(
    definitions: readonly MissionMasterDefinition[],
): DegreeConditionIndex {
    const cached = conditionIndexCache.get(definitions)
    if (cached) return cached

    const mutableIndex = new Map<number, DegreeMissionCandidate[]>()
    for (const definition of definitions) {
        const conditionType = getPositiveInteger(definition.row[3])
        if (conditionType === undefined) continue
        const candidates = mutableIndex.get(conditionType) ?? []
        candidates.push({
            missionId: definition.missionId,
            ...(conditionType === 44
                ? { targetCharacterId: getPositiveInteger(definition.row[15]) }
                : {}),
        })
        mutableIndex.set(conditionType, candidates)
    }

    const index = new Map<number, readonly DegreeMissionCandidate[]>()
    for (const [conditionType, candidates] of mutableIndex) {
        index.set(conditionType, Object.freeze(
            candidates.sort((left, right) => left.missionId - right.missionId),
        ))
    }
    conditionIndexCache.set(definitions, index)
    return index
}

export function getDegreeMissionIdsForConditionTypes(
    conditionTypes: readonly number[],
    characterIds?: readonly number[],
): number[] {
    if (conditionTypes.length === 0) return []

    const characterIdSet = new Set(
        (characterIds ?? []).filter(characterId => getPositiveInteger(characterId) !== undefined),
    )
    const index = getConditionIndex(getMissionMasterDefinitions(5))
    const missionIds = new Set<number>()

    for (const conditionType of new Set(conditionTypes)) {
        for (const candidate of index.get(conditionType) ?? []) {
            if (conditionType === 44) {
                if (candidate.targetCharacterId === undefined
                    || !characterIdSet.has(candidate.targetCharacterId)) continue
            }
            missionIds.add(candidate.missionId)
        }
    }
    return [...missionIds].sort((left, right) => left - right)
}
