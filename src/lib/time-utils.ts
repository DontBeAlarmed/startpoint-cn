// Time utility — reset-hour-aware day/week boundary detection.
// Pure Date-based façade over the frozen game calendar policy; no local
// timezone arithmetic lives here.

import { type GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"

export function getDayBucket(
    date: Date,
    resetHour = 5,
    calendar: GameCalendarPolicy = getGameCalendar(),
): { y: number; m: number; d: number } {
    return calendar.getDayBucket(date.getTime(), resetHour)
}

export function getBusinessDayKey(
    date: Date,
    resetHour = 5,
    calendar: GameCalendarPolicy = getGameCalendar(),
): string {
    const bucket = getDayBucket(date, resetHour, calendar)
    const month = String(bucket.m + 1).padStart(2, "0")
    const day = String(bucket.d).padStart(2, "0")
    return `${bucket.y}-${month}-${day}`
}

export function getWeekBucket(
    date: Date,
    resetHour = 5,
    calendar: GameCalendarPolicy = getGameCalendar(),
): { y: number; w: number } {
    return calendar.getWeekBucket(date.getTime(), resetHour)
}

export function isNewDay(
    now: Date,
    last: Date,
    resetHour = 5,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const a = getDayBucket(now, resetHour, calendar)
    const b = getDayBucket(last, resetHour, calendar)
    return Date.UTC(a.y, a.m, a.d) > Date.UTC(b.y, b.m, b.d)
}

export function isNewWeek(
    now: Date,
    last: Date,
    resetHour = 5,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const a = getWeekBucket(now, resetHour, calendar)
    const b = getWeekBucket(last, resetHour, calendar)
    return a.w > b.w
}
