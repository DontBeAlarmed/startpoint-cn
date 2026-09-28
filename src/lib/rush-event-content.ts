import { Reward, RushEventFolders } from "./types"
import {
    getRushFinalOperationOverrideEvent,
    type RushFinalOperationOverride,
} from "./rush-final-operation-override"
import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getRushEventQuestRounds } from "./quest-content"
import type { ScoreAttackBorderTier } from "./quest/finish/score-attack-handler"

export class RushEventQuestConfigurationError extends Error {
    constructor(
        public readonly eventId: number | undefined,
        public readonly folderId: number | undefined,
    ) {
        super(`Invalid rush event quest configuration: eventId=${eventId} folderId=${folderId}`)
        this.name = "RushEventQuestConfigurationError"
    }
}

export function getRushEventQuestConfigurationErrorResponse(error: unknown): Record<string, unknown> | null {
    if (!(error instanceof RushEventQuestConfigurationError)) return null
    return {
        error: "Internal Server Error",
        message: "Rush event quest configuration is invalid.",
        event_id: error.eventId ?? null,
        folder_id: error.folderId ?? null,
    }
}

export function getRushEventFolderMaxRoundSync(
    eventId: number | undefined,
    folderId: number | undefined,
): number {
    if (!Number.isSafeInteger(eventId) || eventId! <= 0
        || !Number.isSafeInteger(folderId) || folderId! <= 0) {
        throw new RushEventQuestConfigurationError(eventId, folderId)
    }

    const rounds = getRushEventQuestRounds(eventId!, folderId!)
    if (rounds.length === 0) {
        throw new RushEventQuestConfigurationError(eventId, folderId)
    }

    let maxRound = 0
    for (const round of rounds) {
        if (!Number.isSafeInteger(round) || round! <= 0) {
            throw new RushEventQuestConfigurationError(eventId, folderId)
        }
        maxRound = Math.max(maxRound, round!)
    }
    return maxRound
}

export type RushFolderClearRewardProvenance = "OFFICIAL_CONTENT" | "PRIVATE_OVERRIDE"

export interface RushFolderClearRewardResolution {
    readonly rewards: readonly Reward[]
    readonly provenance: RushFolderClearRewardProvenance
}

class RushEventFolderContentError extends Error {
    constructor(eventId: number, folderId: number) {
        super(`Rush event folder clear rewards are invalid: eventId=${eventId} folderId=${folderId}`)
        this.name = "RushEventFolderContentError"
    }
}

/**
 * Resolves the folder clear rewards for a rush event from the official
 * Content Snapshot first. Only when the official row is present but empty
 * and the private final-operation override is enabled for this exact
 * event does the resolution compose the source batch's rewards, marked
 * with PRIVATE_OVERRIDE provenance. Malformed official rows throw instead
 * of silently falling back to private content.
 */
export function resolveRushEventFolderClearRewards(
    rushEventId: number,
    folderId: number,
    rushOverride: RushFinalOperationOverride | null = null,
): RushFolderClearRewardResolution {
    const rushEventQuestFolders = getContentSnapshot().repository.table<RushEventFolders>(
        "rush_event_quest_folder.json",
    )
    const folders = rushEventQuestFolders[rushEventId]
    if (folders === null
        || typeof folders !== "object"
        || Array.isArray(folders)
        || !Object.prototype.hasOwnProperty.call(folders, folderId)) {
        throw new RushEventFolderContentError(rushEventId, folderId)
    }
    const rewards = folders[folderId]
    if (!Array.isArray(rewards)) {
        throw new RushEventFolderContentError(rushEventId, folderId)
    }
    if (rewards.length > 0) {
        return { rewards, provenance: "OFFICIAL_CONTENT" }
    }

    const overrideEvent = getRushFinalOperationOverrideEvent(rushOverride, rushEventId)
    if (overrideEvent === null) return { rewards: [], provenance: "OFFICIAL_CONTENT" }
    const fallbackRewards = rushEventQuestFolders[overrideEvent.sourceEventId]?.[folderId]
    if (fallbackRewards !== undefined && !Array.isArray(fallbackRewards)) {
        throw new RushEventFolderContentError(overrideEvent.sourceEventId, folderId)
    }
    return Array.isArray(fallbackRewards) && fallbackRewards.length > 0
        ? { rewards: fallbackRewards, provenance: "PRIVATE_OVERRIDE" }
        : { rewards: [], provenance: "OFFICIAL_CONTENT" }
}

/**
 * Gets the rewards that should be given when clearing a given folder.
 *
 * @param rushEventId The ID of the rush event.
 * @param folderId The ID of the folder.
 * @returns
 */
export function getRushEventFolderClearRewards(
    rushEventId: number,
    folderId: number,
    rushOverride: RushFinalOperationOverride | null = null,
): Reward[] | null {
    const resolution = resolveRushEventFolderClearRewards(rushEventId, folderId, rushOverride)
    return resolution.rewards.length > 0 ? [...resolution.rewards] : null
}

export function getScoreAttackBorderRewards(): Record<string, ScoreAttackBorderTier[]> {
    return getContentSnapshot().repository.table<Record<string, ScoreAttackBorderTier[]>>(
        "score_attack_border_reward.json",
    )
}

export interface RushEventRankingRewardEntry {
    fromRank: number
    toRank: number
    kind: number
    kindId: number
    number: number
}

export type RushEventRankingRewards = Record<
    string,
    Record<string, RushEventRankingRewardEntry[]>
>

export function getRushEventRankingRewards(): RushEventRankingRewards {
    return getContentSnapshot().repository.table<RushEventRankingRewards>(
        "rush_event_ranking_reward.json",
    )
}
