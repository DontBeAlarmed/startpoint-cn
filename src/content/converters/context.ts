import {
    DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES,
    createGameCalendarPolicy,
    type GameCalendarPolicy,
} from "../../time/game-calendar"

export interface ContentConverterContext {
    readonly gameCalendar: GameCalendarPolicy
}

const DEFAULT_CONTENT_CONVERTER_CONTEXT: ContentConverterContext = Object.freeze({
    gameCalendar: createGameCalendarPolicy(DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES),
})

/**
 * Legacy callers may omit the context; they keep the historical UTC+8
 * behavior. Production sync always passes the release builder's single
 * frozen context.
 */
export function resolveContentConverterContext(
    context?: ContentConverterContext,
): ContentConverterContext {
    return context ?? DEFAULT_CONTENT_CONVERTER_CONTEXT
}

const SUPPORTED_WALL_YEAR_MIN = "1970-01-01 00:00:00"
const SUPPORTED_WALL_YEAR_MAX_EXCLUSIVE = "2201-01-01 00:00:00"

export type GameCalendarSupportedYearRange = {
    readonly minEpochMs: number
    readonly exclusiveMaxEpochMs: number
}

/**
 * Epoch bounds equivalent to the CN master parser's historical 1970..2200
 * wall-year validation, derived through the policy parser itself so no
 * converter keeps private offset arithmetic.
 */
export function gameCalendarSupportedYearRange(
    calendar: GameCalendarPolicy,
): GameCalendarSupportedYearRange {
    return {
        minEpochMs: calendar.parseMasterTimestamp(SUPPORTED_WALL_YEAR_MIN),
        exclusiveMaxEpochMs: calendar.parseMasterTimestamp(SUPPORTED_WALL_YEAR_MAX_EXCLUSIVE),
    }
}
