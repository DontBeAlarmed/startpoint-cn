// Process-wide game calendar freeze point. The production provider starts on
// the CN default offset but is not considered configured until the runtime
// coordinator's "config" stage calls initialize() exactly once (see
// src/runtime/lifecycle.ts and src/cn-server.ts) — before any database, time,
// or content initialization can read it. The offset is process-wide: it is
// never configured per player.

import {
    DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES,
    GameCalendarError,
    createGameCalendarPolicy,
    type GameCalendarPolicy,
} from "./game-calendar"

export interface GameCalendarProvider {
    initialize(utcOffsetMinutes: number): GameCalendarPolicy
    get(): GameCalendarPolicy
}

export function createGameCalendarProvider(
    defaultOffsetMinutes: number = DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES,
): GameCalendarProvider {
    let policy = createGameCalendarPolicy(defaultOffsetMinutes)
    // Any initialize() call or get() freezes the offset. The starting default
    // may still be replaced exactly once before that first touch; repeating
    // the same offset is always an idempotent no-op.
    let frozen = false
    return Object.freeze({
        initialize(utcOffsetMinutes: number): GameCalendarPolicy {
            if (utcOffsetMinutes === policy.utcOffsetMinutes) {
                frozen = true
                return policy
            }
            if (frozen) {
                throw new GameCalendarError(
                    "the game calendar offset is already frozen for this process",
                )
            }
            policy = createGameCalendarPolicy(utcOffsetMinutes)
            frozen = true
            return policy
        },
        get(): GameCalendarPolicy {
            frozen = true
            return policy
        },
    })
}

export const productionGameCalendarProvider = createGameCalendarProvider()

export function getGameCalendar(): GameCalendarPolicy {
    return productionGameCalendarProvider.get()
}
