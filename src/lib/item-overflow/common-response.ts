import {
    normalizePlannedItemOverflowDisposition,
    type PlannedItemOverflowDisposition,
} from "./disposition"

export interface CommonResponseItemOverflow {
    readonly [field: string]: unknown
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

function projectDisposition(value: PlannedItemOverflowDisposition): CommonResponseItemOverflow {
    const normalized = normalizePlannedItemOverflowDisposition(value)
    const itemId = positiveSafeInteger(normalized.itemId, "itemId")
    const overflowAmount = positiveSafeInteger(normalized.overflowAmount, "overflowAmount")
    const item = Object.freeze({ item_id: itemId, number: overflowAmount })
    if (normalized.kind === "mail") {
        return Object.freeze({ process_type: 1 as const, item })
    }
    return Object.freeze({ process_type: 2 as const, amount_sold: normalized.soldMana, item })
}

export function projectItemOverflowCommonResponse(
    dispositions: readonly PlannedItemOverflowDisposition[],
): readonly CommonResponseItemOverflow[] {
    if (!Array.isArray(dispositions)) {
        throw new TypeError("overflow dispositions must be an array")
    }
    return Object.freeze(dispositions.map(projectDisposition))
}
