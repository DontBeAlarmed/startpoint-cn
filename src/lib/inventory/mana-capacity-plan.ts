export interface ManaCapacityPlanInput {
    readonly freeMana: number
    readonly paidMana: number
    readonly maxMana: number
    readonly requestedMana: number
}

export interface ManaCapacityPlan {
    readonly currentTotalMana: number
    readonly capacityMana: number
    readonly acceptedMana: number
    readonly overflowMana: number
}

function requireMana(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`)
    }
    return value
}

export function planManaCapacity(input: ManaCapacityPlanInput): ManaCapacityPlan {
    const freeMana = requireMana(input.freeMana, "freeMana")
    const paidMana = requireMana(input.paidMana, "paidMana")
    const maxMana = requireMana(input.maxMana, "maxMana")
    const requestedMana = requireMana(input.requestedMana, "requestedMana")
    const currentTotalMana = freeMana + paidMana
    if (!Number.isSafeInteger(currentTotalMana)) {
        throw new RangeError("current total Mana must be a safe integer")
    }
    const capacityMana = Math.max(0, maxMana - currentTotalMana)
    const acceptedMana = Math.min(requestedMana, capacityMana)
    return Object.freeze({
        currentTotalMana,
        capacityMana,
        acceptedMana,
        overflowMana: requestedMana - acceptedMana,
    })
}
