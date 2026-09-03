import type { ItemInventoryPolicy } from "../inventory/item-inventory-policy"
import { planManaCapacity } from "../inventory/mana-capacity-plan"

export type PlannedItemOverflowDisposition =
    | Readonly<{
        kind: "mail"
        itemId: number
        overflowAmount: number
    }>
    | Readonly<{
        kind: "sold"
        itemId: number
        overflowAmount: number
        soldMana: number
        manaBefore: number
        acceptedMana: number
        overflowMana: number
        manaAfter: number
    }>

export interface PlanItemOverflowDispositionInput {
    readonly itemId: number
    readonly overflowAmount: number
    readonly policy: ItemInventoryPolicy
    readonly freeMana: number
    readonly paidMana: number
    readonly maxMana: number
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

export function planItemOverflowDisposition(
    input: PlanItemOverflowDispositionInput,
): PlannedItemOverflowDisposition {
    const itemId = positiveSafeInteger(input.itemId, "itemId")
    const overflowAmount = positiveSafeInteger(input.overflowAmount, "overflowAmount")
    const salePrice = nonNegativeSafeInteger(input.policy.salePrice, "policy.salePrice")
    if (typeof input.policy.sellable !== "boolean") {
        throw new TypeError("policy.sellable must be a boolean")
    }
    const manaCapacityInput = {
        freeMana: nonNegativeSafeInteger(input.freeMana, "freeMana"),
        paidMana: nonNegativeSafeInteger(input.paidMana, "paidMana"),
        maxMana: nonNegativeSafeInteger(input.maxMana, "maxMana"),
    }
    planManaCapacity({ ...manaCapacityInput, requestedMana: 0 })
    if (!input.policy.sellable) {
        return Object.freeze({ kind: "mail", itemId, overflowAmount })
    }
    const soldMana = overflowAmount * salePrice
    if (!Number.isSafeInteger(soldMana) || soldMana < 0) {
        throw new RangeError("soldMana exceeds the safe integer range")
    }
    const capacity = planManaCapacity({
        ...manaCapacityInput,
        requestedMana: soldMana,
    })
    const manaAfter = manaCapacityInput.freeMana + capacity.acceptedMana
    if (!Number.isSafeInteger(manaAfter)) {
        throw new RangeError("manaAfter exceeds the safe integer range")
    }
    return Object.freeze({
        kind: "sold",
        itemId,
        overflowAmount,
        soldMana,
        manaBefore: manaCapacityInput.freeMana,
        acceptedMana: capacity.acceptedMana,
        overflowMana: capacity.overflowMana,
        manaAfter,
    })
}
