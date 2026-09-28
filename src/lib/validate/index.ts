// Save validator system — runs permanent validators on /load.
// Temporal filters are applied at serialization time (see load.ts).

import { SaveValidator, TemporalFilter } from "./types"
import { MaxLevelValidator } from "./max-level"
import { PartySlotValidator } from "./party-slot"
import type { Player } from "../../data/types"

const PERMANENT_VALIDATORS: SaveValidator[] = [
    MaxLevelValidator,
    PartySlotValidator,
]

const TEMPORAL_FILTERS: TemporalFilter[] = [
    // Add temporal filters here (e.g. ExBoostReleaseFilter, ItemReleaseFilter)
]

/** Run all permanent validators. Returns total fixes applied. */
export function runPermanentValidators(playerId: number, player?: Player): number {
    let totalFixes = 0
    for (const v of PERMANENT_VALIDATORS) {
        try {
            totalFixes += v.validate(playerId, player)
        } catch (e) {
            console.error(`[VALIDATE:${v.name}] error:`, e)
        }
    }
    if (totalFixes > 0) {
        console.log(`[VALIDATE] player=${playerId}: ${totalFixes} total permanent fixes`)
    }
    return totalFixes
}

/** Apply all temporal filters to serialized output. */
export function applyTemporalFilters<T extends Record<string, any>>(output: T): T {
    for (const f of TEMPORAL_FILTERS) {
        try {
            output = f.apply(output)
        } catch (e) {
            console.error(`[VALIDATE:${f.name}] filter error:`, e)
        }
    }
    return output
}
