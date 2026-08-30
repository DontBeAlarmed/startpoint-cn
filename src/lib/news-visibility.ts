import { parseTimezoneAwareCalendarTimestamp } from "./news-time"

interface NewsWithDate {
    readonly date?: unknown
    readonly publishedAtReal?: unknown
}

function parseLegacyDateMs(value: unknown): number | null {
    if (typeof value !== "string") return null

    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) return null

    const [, year, month, day, hour, minute, second] = match
    const timestamp = Date.parse(
        `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`,
    )
    return Number.isNaN(timestamp) ? null : timestamp
}

export function isNewsVisibleAt(news: NewsWithDate, nowMs: number): boolean {
    if (news.publishedAtReal !== undefined) {
        const publishedAtMs = parseTimezoneAwareCalendarTimestamp(news.publishedAtReal)
        return Number.isFinite(publishedAtMs) && publishedAtMs <= nowMs
    }

    const publishedAtMs = parseLegacyDateMs(news.date)
    return publishedAtMs === null || publishedAtMs <= nowMs
}
