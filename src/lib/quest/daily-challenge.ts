import { QuestCategory } from "../types"

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
