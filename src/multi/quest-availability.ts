export interface QuestAvailabilityPeriod {
    readonly availableFromMs: number | null
    readonly availableUntilMs: number | null
}

export type QuestAvailabilityResult =
    | { readonly available: true }
    | { readonly available: false; readonly code: "QUEST_NOT_AVAILABLE" }

const EXPLICIT_ACTIVITY_CATEGORIES = new Set([
    7, 8, 10, 11, 13, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
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
