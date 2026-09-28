import type { GachaPeriod } from "./model"
import { GameCalendarError, type GameCalendarPolicy } from "../../time/game-calendar"
import { getGameCalendar } from "../../time/game-calendar-provider"

export class GachaPeriodError extends Error {
    readonly resultCode = 1351
}

// Compatibility alias kept for gacha-catalog consumers: strict parsing and the
// CN client's fixed offset now come from the game calendar policy, so the
// historical "Jst" name no longer implies a hard-coded UTC+9 conversion.
export function parseGachaJstTimestamp(
    value: string,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) {
            throw new TypeError(`Invalid Gacha period: ${value}.`)
        }
        throw error
    }
}

export function isGachaPeriodAvailable(
    period: GachaPeriod,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    return Number.isFinite(nowMs)
        && nowMs >= parseGachaJstTimestamp(period.availableFrom, calendar)
        && nowMs <= parseGachaJstTimestamp(period.availableUntil, calendar)
}
