interface NewsWithDate {
    readonly date?: unknown
    readonly publishedAtReal?: unknown
}

function parseTimestampMs(value: unknown): number | null {
    if (typeof value !== "string") return null

    const isoTimestamp = Date.parse(value)
    if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(isoTimestamp)) {
        return isoTimestamp
    }

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
        const publishedAtMs = parseTimestampMs(news.publishedAtReal)
        return publishedAtMs !== null && publishedAtMs <= nowMs
    }

    const publishedAtMs = parseTimestampMs(news.date)
    return publishedAtMs === null || publishedAtMs <= nowMs
}
