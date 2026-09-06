import { QuestCategory } from "../types"
import { getContentSnapshot, type ReadonlyContentRepository } from "../../content/runtime/content-snapshot"

export interface DailyChallengePointDefinition {
    readonly id: number
    readonly maxPoint: number
    readonly isRecovery: boolean
}

type DailyChallengePointLookupTable = Record<string, { maxPoint: number, isRecovery: boolean, name: string }>

const definitionsByRepository = new WeakMap<ReadonlyContentRepository, readonly DailyChallengePointDefinition[]>()

export function getDailyChallengePointDefinitions(): readonly DailyChallengePointDefinition[] {
    const repository = getContentSnapshot().repository
    const cached = definitionsByRepository.get(repository)
    if (cached) return cached
    const lookup = repository.table<DailyChallengePointLookupTable>("daily_challenge_point_lookup.json")
    const definitions = Object.freeze(Object.entries(lookup).map(([idStr, data]) => ({
        id: Number(idStr),
        maxPoint: data.maxPoint,
        isRecovery: data.isRecovery,
    })))
    definitionsByRepository.set(repository, definitions)
    return definitions
}

export function getDailyChallengePointDefinition(
    challengePointId: number,
): DailyChallengePointDefinition | undefined {
    return getDailyChallengePointDefinitions().find(definition => definition.id === challengePointId)
}

export class DailyChallengePointExhaustedError extends Error {
    constructor(public readonly challengePointId: number) {
        super(`Daily challenge point ${challengePointId} is exhausted.`)
        this.name = "DailyChallengePointExhaustedError"
    }
}

export class DailyChallengePointUnavailableError extends Error {
    constructor(public readonly challengePointId: number) {
        super(`Daily challenge point ${challengePointId} is unavailable.`)
        this.name = "DailyChallengePointUnavailableError"
    }
}

export function getDailyChallengePointId(
    questCategory: QuestCategory,
    questId: number,
    eventId: number | undefined,
    challengePointMap: Record<string, number>,
): number | undefined {
    if (questCategory === QuestCategory.STORY_EVENT_SINGLE) {
        return challengePointMap[`story_${questId}`]
    }
    if (questCategory === QuestCategory.EXPERT_SINGLE_EVENT && eventId !== undefined) {
        return challengePointMap[`expert_${eventId}`]
    }
    if (questCategory === QuestCategory.SOLO_TIME_ATTACK_EVENT && eventId !== undefined) {
        return challengePointMap[`solo_${eventId}`]
    }
    return undefined
}

export function assertDailyChallengePointAvailable(
    challengePointId: number | undefined,
    entries: ReadonlyArray<{ id: number; point: number }>,
): void {
    if (challengePointId === undefined) return
    const entry = entries.find(candidate => candidate.id === challengePointId)
    if (entry === undefined) {
        throw new DailyChallengePointUnavailableError(challengePointId)
    }
    if (entry !== undefined && entry.point <= 0) {
        throw new DailyChallengePointExhaustedError(challengePointId)
    }
}
