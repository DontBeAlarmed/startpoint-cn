import { QuestCategory } from "../types"
import { getContentSnapshot, type ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { validateDailyChallengeContent } from "../../content/validation/quest-derived-output"

export interface DailyChallengePointDefinition {
    readonly id: number
    readonly maxPoint: number
    readonly isRecovery: boolean
}

type DailyChallengePointLookupTable = Record<string, { maxPoint: number, isRecovery: boolean, name: string }>

interface DailyChallengeCatalog {
    readonly definitions: readonly DailyChallengePointDefinition[]
    readonly eventPointMap: Readonly<Record<string, number>>
}

const catalogs = new WeakMap<ReadonlyContentRepository, DailyChallengeCatalog>()

export function getDailyChallengeCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): DailyChallengeCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = validateDailyChallengeContent({
        lookup: repository.table("daily_challenge_point_lookup.json"),
        eventPointMap: repository.table("event_challenge_point_map.json"),
    }) as DailyChallengeCatalog
    catalogs.set(repository, catalog)
    return catalog
}

export function getDailyChallengePointDefinitions(): readonly DailyChallengePointDefinition[] {
    return getDailyChallengeCatalog().definitions
}

export function getEventChallengePointMap(): Readonly<Record<string, number>> {
    return getDailyChallengeCatalog().eventPointMap
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
