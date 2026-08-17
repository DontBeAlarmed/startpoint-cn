import type { RewardGrantPlayerAfter } from "./types"

export type RewardGrantKnownPlayerField = "freeMana" | "freeVmoney" | "expPool"

export class RewardGrantKnownPlayerValidationError extends Error {
    readonly field: RewardGrantKnownPlayerField

    constructor(field: RewardGrantKnownPlayerField) {
        super(`Invalid known reward grant player field: ${field}`)
        this.name = "RewardGrantKnownPlayerValidationError"
        this.field = field
    }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function snapshotKnownRewardGrantPlayer(
    value: RewardGrantPlayerAfter,
): RewardGrantPlayerAfter {
    if (typeof value !== "object" || value === null) {
        throw new RewardGrantKnownPlayerValidationError("freeMana")
    }
    const runtime = value as unknown as Record<string, unknown>
    const freeMana = runtime.freeMana
    const freeVmoney = runtime.freeVmoney
    const expPool = runtime.expPool

    if (!isNonNegativeSafeInteger(freeMana)) {
        throw new RewardGrantKnownPlayerValidationError("freeMana")
    }
    if (!isNonNegativeSafeInteger(freeVmoney)) {
        throw new RewardGrantKnownPlayerValidationError("freeVmoney")
    }
    if (!isNonNegativeSafeInteger(expPool)) {
        throw new RewardGrantKnownPlayerValidationError("expPool")
    }
    return { freeMana, freeVmoney, expPool }
}
