// Time utility — reset-hour-aware day/week boundary detection

const resetHour = parseInt(process.env.DAILY_RESET_HOUR || '5', 10)
const cnUtcOffsetHours = 8

function shiftByResetHour(date: Date): Date {
    return new Date(date.getTime() + (cnUtcOffsetHours - resetHour) * 3600_000)
}

export function getDayBucket(date: Date): { y: number; m: number; d: number } {
    const s = shiftByResetHour(date)
    return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate() }
}

export function getWeekBucket(date: Date): { y: number; w: number } {
    // CN week resets at Monday 05:00 (UTC+8).
    const s = shiftByResetHour(date)
    const start = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()))
    const dayOfWeek = start.getUTCDay()
    const daysSinceMonday = (dayOfWeek + 6) % 7
    const monday = new Date(start.getTime() - daysSinceMonday * 86400_000)
    return { y: monday.getUTCFullYear(), w: Math.floor(monday.getTime() / (7 * 86400_000)) }
}

export function isNewDay(now: Date, last: Date): boolean {
    const a = getDayBucket(now)
    const b = getDayBucket(last)
    return Date.UTC(a.y, a.m, a.d) > Date.UTC(b.y, b.m, b.d)
}

export function isNewWeek(now: Date, last: Date): boolean {
    const a = getWeekBucket(now)
    const b = getWeekBucket(last)
    return a.w > b.w
}
