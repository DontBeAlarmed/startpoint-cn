import { QuestCategory } from "../lib/types/quest"

export interface QuestAvailabilityPeriod {
    readonly availableFromMs: number | null
    readonly availableUntilMs: number | null
}

export type QuestAvailabilityResult =
    | { readonly available: true }
    | { readonly available: false; readonly code: "QUEST_NOT_AVAILABLE" }

const EXPLICIT_ACTIVITY_CATEGORIES = new Set([
    QuestCategory.ADVENT_EVENT_SINGLE,
    QuestCategory.ADVENT_EVENT_MULTI,
    QuestCategory.STORY_EVENT_SINGLE,
    QuestCategory.RANKING_EVENT_SINGLE,
    QuestCategory.CHALLENGE_DUNGEON_EVENT,
    QuestCategory.WORLD_STORY_EVENT,
    QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    QuestCategory.TOWER_DUNGEON_EVENT,
    QuestCategory.EXPERT_SINGLE_EVENT,
    QuestCategory.CARNIVAL_EVENT,
    QuestCategory.RAID_EVENT,
    QuestCategory.RUSH_EVENT,
    QuestCategory.SOLO_TIME_ATTACK_EVENT,
    QuestCategory.HARD_MULTI_EVENT,
    QuestCategory.SCORE_ATTACK_EVENT,
])

function isValidBoundary(value: number | null): boolean {
    return value === null || (Number.isSafeInteger(value) && Number.isFinite(value))
}

export function checkQuestAvailability(
    period: QuestAvailabilityPeriod,
    nowMs: number,
): QuestAvailabilityResult {
    const from = period?.availableFromMs
    const until = period?.availableUntilMs
    if (!Number.isSafeInteger(nowMs)
        || !isValidBoundary(from)
        || !isValidBoundary(until)
        || (from !== null && until !== null && from > until)
        || (from !== null && nowMs < from)
        || (until !== null && nowMs > until)) {
        return { available: false, code: "QUEST_NOT_AVAILABLE" }
    }
    return { available: true }
}

export function checkLocalQuestAvailability(
    quest: {
        readonly availableFromMs?: number | null
        readonly availableUntilMs?: number | null
    },
    category: number,
    nowMs: number,
): QuestAvailabilityResult {
    const hasFrom = Object.prototype.hasOwnProperty.call(quest, "availableFromMs")
    const hasUntil = Object.prototype.hasOwnProperty.call(quest, "availableUntilMs")
    if (!hasFrom && !hasUntil) {
        return EXPLICIT_ACTIVITY_CATEGORIES.has(category)
            ? { available: false, code: "QUEST_NOT_AVAILABLE" }
            : { available: true }
    }
    if (!hasFrom || !hasUntil) {
        return { available: false, code: "QUEST_NOT_AVAILABLE" }
    }
    return checkQuestAvailability({
        availableFromMs: quest.availableFromMs ?? null,
        availableUntilMs: quest.availableUntilMs ?? null,
    }, nowMs)
}
