import { Reward, RushEventFolders } from "./types"
import { getRushCompatibilityEvent } from "./shop/rush-compatibility"
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

/**
 * Gets the rewards that should be given when clearing a given folder.
 *
 * @param rushEventId The ID of the rush event.
 * @param folderId The ID of the folder.
 * @returns
 */
export function getRushEventFolderClearRewards(
    rushEventId: number,
    folderId: number
): Reward[] | null {
    const rushEventQuestFolders = getContentSnapshot().repository.table<RushEventFolders>(
        "rush_event_quest_folder.json",
    )
    const folders = rushEventQuestFolders[rushEventId]
    const rewards = folders?.[folderId]
    if (Array.isArray(rewards) && rewards.length > 0) return rewards

    const compatibility = getRushCompatibilityEvent(rushEventId)
    if (compatibility === null) return null
    const fallbackRewards = rushEventQuestFolders[compatibility.sourceEventId]?.[folderId]
    return Array.isArray(fallbackRewards) && fallbackRewards.length > 0 ? fallbackRewards : null
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
