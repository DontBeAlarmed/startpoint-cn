// Pure game calendar policy — fixed UTC offset, host-TZ-independent business
// day/week/month math. Reads no process.env, database, or local timezone.

export class GameCalendarError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "GameCalendarError"
    }
}

export const DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES = 480

const MIN_OFFSET_MINUTES = -14 * 60
const MAX_OFFSET_MINUTES = 14 * 60
const MASTER_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * 86_400_000
const MAX_REPRESENTABLE_EPOCH_MS = 8.64e15 // Date value range limit

export type CalendarDayBucket = { readonly y: number; readonly m: number; readonly d: number }

export type CalendarWeekBucket = { readonly y: number; readonly w: number }

export interface GameCalendarPolicy {
    readonly utcOffsetMinutes: number
    parseMasterTimestamp(value: string): number
    formatMasterTimestamp(epochMs: number): string
    getDayBucket(epochMs: number, resetHour?: number): CalendarDayBucket
    getWeekBucket(epochMs: number, resetHour?: number): CalendarWeekBucket
    getMonth(epochMs: number): number
}

export function parseGameCalendarUtcOffsetMinutes(value: string | undefined): number {
    if (value === undefined) return DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES
    if (!/^(?:0|[1-9]\d*|-[1-9]\d*|\+[1-9]\d*)$/.test(value)) {
        throw new GameCalendarError("invalid game calendar UTC offset minutes")
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < MIN_OFFSET_MINUTES || parsed > MAX_OFFSET_MINUTES) {
        throw new GameCalendarError("invalid game calendar UTC offset minutes")
    }
    return parsed
}

function requireFiniteEpoch(epochMs: number): number {
    if (!Number.isFinite(epochMs)) {
        throw new GameCalendarError("epoch milliseconds must be finite")
    }
    return epochMs
}

function requireResetHour(resetHour: number | undefined): number {
    const hour = resetHour ?? 0
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new GameCalendarError("invalid reset hour")
    }
    return hour
}

function isGameCalendarLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInGameCalendarMonth(year: number, month1: number): number {
    if (month1 === 2 && isGameCalendarLeapYear(year)) return 29
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1 - 1]
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, "0")
}

export function createGameCalendarPolicy(utcOffsetMinutes: number): GameCalendarPolicy {
    if (
        !Number.isSafeInteger(utcOffsetMinutes)
        || utcOffsetMinutes < MIN_OFFSET_MINUTES
        || utcOffsetMinutes > MAX_OFFSET_MINUTES
    ) {
        throw new GameCalendarError("invalid game calendar UTC offset minutes")
    }
    const offsetMinutes = utcOffsetMinutes

    return Object.freeze({
        utcOffsetMinutes: offsetMinutes,
        parseMasterTimestamp(value: string): number {
            const match = MASTER_TIMESTAMP.exec(value)
            if (match === null) throw new GameCalendarError("invalid master timestamp")
            const year = Number(match[1])
            const month1 = Number(match[2])
            const day = Number(match[3])
            const hour = Number(match[4])
            const minute = Number(match[5])
            const second = Number(match[6])
            if (
                month1 < 1 || month1 > 12
                || day < 1 || day > daysInGameCalendarMonth(year, month1)
                || hour > 23 || minute > 59 || second > 59
            ) {
                throw new GameCalendarError("invalid master timestamp")
            }
            // Build wall-clock milliseconds with UTC field setters so years
            // 0..99 are not remapped to 19xx.
            const wall = new Date(0)
            wall.setUTCFullYear(year, month1 - 1, day)
            wall.setUTCHours(hour, minute, second, 0)
            return wall.getTime() - offsetMinutes * MS_PER_MINUTE
        },
        formatMasterTimestamp(epochMs: number): string {
            requireFiniteEpoch(epochMs)
            const wallMs = epochMs + offsetMinutes * MS_PER_MINUTE
            if (!Number.isFinite(wallMs) || Math.abs(wallMs) > MAX_REPRESENTABLE_EPOCH_MS) {
                throw new GameCalendarError("epoch milliseconds outside the four-digit game calendar range")
            }
            const wall = new Date(wallMs)
            const year = wall.getUTCFullYear()
            if (year < 0 || year > 9999) {
                throw new GameCalendarError("epoch milliseconds outside the four-digit game calendar range")
            }
            // Canonical second precision; sub-second display precision is discarded.
            return `${pad(year, 4)}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}`
                + ` ${pad(wall.getUTCHours(), 2)}:${pad(wall.getUTCMinutes(), 2)}:${pad(wall.getUTCSeconds(), 2)}`
        },
        getDayBucket(epochMs: number, resetHour?: number): CalendarDayBucket {
            requireFiniteEpoch(epochMs)
            const hour = requireResetHour(resetHour)
            const shifted = new Date(epochMs + (offsetMinutes - hour * 60) * MS_PER_MINUTE)
            return Object.freeze({
                y: shifted.getUTCFullYear(),
                m: shifted.getUTCMonth(),
                d: shifted.getUTCDate(),
            })
        },
        getWeekBucket(epochMs: number, resetHour?: number): CalendarWeekBucket {
            requireFiniteEpoch(epochMs)
            const hour = requireResetHour(resetHour)
            const shifted = new Date(epochMs + (offsetMinutes - hour * 60) * MS_PER_MINUTE)
            const dayStart = new Date(0)
            dayStart.setUTCFullYear(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
            const daysSinceMonday = (dayStart.getUTCDay() + 6) % 7
            const mondayMs = dayStart.getTime() - daysSinceMonday * MS_PER_DAY
            const monday = new Date(mondayMs)
            // Preserves the epoch-week index contract of src/lib/time-utils.ts.
            return Object.freeze({
                y: monday.getUTCFullYear(),
                w: Math.floor(mondayMs / MS_PER_WEEK),
            })
        },
        getMonth(epochMs: number): number {
            requireFiniteEpoch(epochMs)
            return new Date(epochMs + offsetMinutes * MS_PER_MINUTE).getUTCMonth() + 1
        },
    })
}
