import { parseTimezoneAwareCalendarTimestamp } from "./news-time"
import { GameCalendarError, type GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"

interface NewsWithDate {
    readonly date?: unknown
    readonly publishedAtReal?: unknown
}

function parseLegacyDateMs(
    value: unknown,
    calendar: GameCalendarPolicy,
): number | null {
    if (typeof value !== "string") return null

    // Explicit timezone-aware ISO values stay absolute UTC timestamps.
    const isoTimestamp = Date.parse(value)
    if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(isoTimestamp)) {
        return isoTimestamp
    }

    // Legacy offset-less master dates follow the game calendar policy.
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) return null
        throw error
    }
}

export function isNewsVisibleAt(
    news: NewsWithDate,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    if (news.publishedAtReal !== undefined) {
        const publishedAtMs = parseTimezoneAwareCalendarTimestamp(news.publishedAtReal)
        return Number.isFinite(publishedAtMs) && publishedAtMs <= nowMs
    }

    const publishedAtMs = parseLegacyDateMs(news.date, calendar)
    return publishedAtMs === null || publishedAtMs <= nowMs
}
