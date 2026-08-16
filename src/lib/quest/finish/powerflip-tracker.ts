// Accumulates zone-level powerflip and dash counters for mission progress

import { updatePlayerSync } from "../../../data/domains/player"
import type { FinishContext } from "./types"

export const MAX_SAFE_BATTLE_COUNTER = Number.MAX_SAFE_INTEGER

function normalizeNonNegativeSafeInteger(value: unknown): number {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

export function saturatingAddNonNegativeSafeIntegers(existing: unknown, delta: unknown): number {
    const normalizedExisting = normalizeNonNegativeSafeInteger(existing)
    const normalizedDelta = normalizeNonNegativeSafeInteger(delta)
    if (normalizedDelta > MAX_SAFE_BATTLE_COUNTER - normalizedExisting) {
        return MAX_SAFE_BATTLE_COUNTER
    }
    return normalizedExisting + normalizedDelta
}

export function trackPowerflip(ctx: FinishContext): void {
    const zones = ctx.statistics.zones || []
    let powerFlipCount = 0
    let dashCount = 0
    for (const zone of zones) {
        powerFlipCount = saturatingAddNonNegativeSafeIntegers(
            powerFlipCount,
            zone.use_power_flip_count ?? 0,
        )
        dashCount = saturatingAddNonNegativeSafeIntegers(dashCount, zone.use_dash_count ?? 0)
    }
    if (powerFlipCount > 0 || dashCount > 0) {
        updatePlayerSync({
            id: ctx.playerId,
            totalPowerflips: saturatingAddNonNegativeSafeIntegers(
                ctx.player.totalPowerflips,
                powerFlipCount,
            ),
            totalDashes: saturatingAddNonNegativeSafeIntegers(ctx.player.totalDashes, dashCount),
        })
    }
}
