import type { FactKey } from "./facts/fact-key"

export interface LegacyAwakeRewardResult {
    readonly user_info?: {
        readonly free_mana?: unknown
    }
}

const NO_INVALIDATIONS: readonly FactKey[] = Object.freeze([])
const PLAYER_INVALIDATION: readonly FactKey[] = Object.freeze([
    Object.freeze({ kind: "player" as const }),
])

export function getAwakeFactKeysFromLegacyRewardResults(
    ...results: readonly (LegacyAwakeRewardResult | null | undefined)[]
): readonly FactKey[] {
    return results.some(result => {
        const value = result?.user_info?.free_mana
        return typeof value === "number"
            && Number.isSafeInteger(value)
            && value > 0
    }) ? PLAYER_INVALIDATION : NO_INVALIDATIONS
}
