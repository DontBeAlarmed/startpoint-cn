import type { PlannedItemOverflowDisposition } from "./disposition"

export interface CommonResponseItemOverflow {
    readonly process_type: 1 | 2
    readonly item: Readonly<{
        readonly item_id: number
        readonly number: number
    }>
    readonly amount_sold?: number
}

function positiveSafeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value
}

function projectDisposition(value: PlannedItemOverflowDisposition): CommonResponseItemOverflow {
    if (!value || typeof value !== "object") {
        throw new TypeError("overflow disposition must be an object")
    }
    const itemId = positiveSafeInteger(value.itemId, "itemId")
    const overflowAmount = positiveSafeInteger(value.overflowAmount, "overflowAmount")
    const item = Object.freeze({ item_id: itemId, number: overflowAmount })
    if (value.kind === "mail") {
        return Object.freeze({ process_type: 1 as const, item })
    }
    if (value.kind !== "sold") {
        throw new TypeError("overflow disposition kind is unsupported")
    }
    const soldMana = nonNegativeSafeInteger(value.soldMana, "soldMana")
    const acceptedMana = nonNegativeSafeInteger(value.acceptedMana, "acceptedMana")
    const overflowMana = nonNegativeSafeInteger(value.overflowMana, "overflowMana")
    const manaBefore = nonNegativeSafeInteger(value.manaBefore, "manaBefore")
    const manaAfter = nonNegativeSafeInteger(value.manaAfter, "manaAfter")
    if (acceptedMana + overflowMana !== soldMana
        || !Number.isSafeInteger(manaBefore + acceptedMana)
        || manaBefore + acceptedMana !== manaAfter) {
        throw new TypeError("sold overflow disposition is inconsistent")
    }
    return Object.freeze({ process_type: 2 as const, amount_sold: soldMana, item })
}

export function projectItemOverflowCommonResponse(
    dispositions: readonly PlannedItemOverflowDisposition[],
): readonly CommonResponseItemOverflow[] {
    if (!Array.isArray(dispositions)) {
        throw new TypeError("overflow dispositions must be an array")
    }
    return Object.freeze(dispositions.map(projectDisposition))
}
