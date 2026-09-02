export interface ItemCapPlanInput {
    readonly currentAmount: number
    readonly requestedAmount: number
    readonly maxCount: number
}

export interface ItemCapPlan {
    readonly beforeAmount: number
    readonly afterAmount: number
    readonly acceptedAmount: number
    readonly overflowAmount: number
}

function requireAmount(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`)
    }
    return value
}

export function planItemCap(input: ItemCapPlanInput): ItemCapPlan {
    const currentAmount = requireAmount(input.currentAmount, "currentAmount")
    const requestedAmount = requireAmount(input.requestedAmount, "requestedAmount")
    const maxCount = requireAmount(input.maxCount, "maxCount")
    const capacity = Math.max(0, maxCount - currentAmount)
    const acceptedAmount = Math.min(requestedAmount, capacity)
    const afterAmount = currentAmount + acceptedAmount
    if (!Number.isSafeInteger(afterAmount)) {
        throw new RangeError("item cap plan result must be a safe integer")
    }
    return Object.freeze({
        beforeAmount: currentAmount,
        afterAmount,
        acceptedAmount,
        overflowAmount: requestedAmount - acceptedAmount,
    })
}
