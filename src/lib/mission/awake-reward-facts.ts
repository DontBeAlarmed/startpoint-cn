import type { RewardGrantExecutionResult } from "../reward-grant"
import type { FactKey } from "./facts/fact-key"

const NO_INVALIDATIONS: readonly FactKey[] = Object.freeze([])
const PLAYER_INVALIDATION: readonly FactKey[] = Object.freeze([
    Object.freeze({ kind: "player" as const }),
])

export function getAwakeFactKeysFromRewardGrants(
    ...results: readonly (RewardGrantExecutionResult | null | undefined)[]
): readonly FactKey[] {
    return results.some(result => result?.assets.currencies.some(currency => (
        currency.currency === "freeMana" && currency.requestedAmount > 0
    ))) ? PLAYER_INVALIDATION : NO_INVALIDATIONS
}
