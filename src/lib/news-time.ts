const TIMEZONE_AWARE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

export function parseTimezoneAwareCalendarTimestamp(value: unknown): number {
    if (typeof value !== "string") return Number.NaN
    const match = TIMEZONE_AWARE_TIMESTAMP.exec(value)
    if (match === null) return Number.NaN

    const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, rawFraction, rawOffset]
        = match
    const year = Number(rawYear)
    const month = Number(rawMonth)
    const day = Number(rawDay)
    const hour = Number(rawHour)
    const minute = Number(rawMinute)
    const second = Number(rawSecond)
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
        return Number.NaN
    }

    const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]
    if (day < 1 || day > daysInMonth[month - 1]) return Number.NaN

    const offsetMatch = rawOffset === "Z"
        ? null
        : /^([+-])(\d{2}):(\d{2})$/.exec(rawOffset)
    if (offsetMatch !== null
        && (Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59)) {
        return Number.NaN
    }

    const offsetDirection = offsetMatch === null || offsetMatch[1] === "+" ? 1 : -1
    const offsetMinutes = offsetMatch === null
        ? 0
        : Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])
    const fractionMs = rawFraction === undefined
        ? 0
        : Number(rawFraction.slice(0, 3).padEnd(3, "0"))

    // Date.UTC remaps years 0 through 99 to 1900 through 1999; explicit UTC
    // setters preserve all four-digit years.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, fractionMs)
    return date.getTime() - offsetDirection * offsetMinutes * 60_000
}
