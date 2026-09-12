// SaveValidator interface — each validator checks and repairs one data category.
// Permanent validators can write to DB. Temporal filters modify output only.

import type { Player } from "../../data/types"

export interface SaveValidator {
    readonly name: string
    /**
     * Validate & repair one player save.
     * @returns number of fixes applied (0 = clean).
     */
    validate(playerId: number, player?: Player): number
}

/** Filter applied to serialized output (does not modify DB). */
export interface TemporalFilter {
    readonly name: string
    /** @returns filtered output object (shallow copy with removed entries). */
    apply<T extends Record<string, any>>(output: T): T
}
