import type { ManaNodeMutationPlan } from "../character-mana-mutation-types"
import { computeManaDeduction } from "../character-helpers"
import { growthError } from "./errors"

export interface CharacterGrowthResourcePlan {
    readonly totalManaCost: number
    readonly totalItemCosts: ReadonlyMap<number, number>
    readonly manaBefore: number
    readonly manaAfter: number
    readonly freeManaAfter: number
    readonly paidManaAfter: number
    readonly itemsBefore: ReadonlyMap<number, number>
    readonly itemsAfter: ReadonlyMap<number, number>
}

export interface CharacterGrowthResourcePlanInput {
    readonly mutationPlan: Pick<ManaNodeMutationPlan, "totalManaCost" | "totalItemCosts">
    readonly freeMana: number
    readonly paidMana: number
    readonly itemBalances: ReadonlyMap<number, number>
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a non-negative safe integer.`)
    }
    return value
}

/**
 * Converts an already validated mutation plan into absolute DB after-state.
 * The plan owns aggregation; this function owns the final balance checks and
 * the free-mana-before-paid-mana deduction rule.
 */
export function planCharacterGrowthResources(
    input: CharacterGrowthResourcePlanInput,
): CharacterGrowthResourcePlan {
    const freeMana = nonNegativeInteger(input.freeMana, "freeMana")
    const paidMana = nonNegativeInteger(input.paidMana, "paidMana")
    const manaBefore = freeMana + paidMana
    if (!Number.isSafeInteger(manaBefore)) {
        throw growthError("INVALID_GROWTH_STATE", "mana balance exceeds safe integer range.")
    }

    const totalManaCost = nonNegativeInteger(input.mutationPlan.totalManaCost, "totalManaCost")
    if (totalManaCost > manaBefore) {
        throw growthError("INSUFFICIENT_MANA", "player does not have enough mana.")
    }

    const totalItemCosts = new Map<number, number>()
    const itemsBefore = new Map<number, number>()
    const itemsAfter = new Map<number, number>()
    for (const [rawItemId, rawCost] of Object.entries(input.mutationPlan.totalItemCosts)) {
        const itemId = Number(rawItemId)
        const cost = nonNegativeInteger(rawCost, `item ${rawItemId} cost`)
        const amount = input.itemBalances.get(itemId) ?? 0
        nonNegativeInteger(amount, `item ${rawItemId} balance`)
        if (amount < cost) {
            throw growthError("INSUFFICIENT_ITEM", `player does not have enough item ${itemId}.`)
        }
        totalItemCosts.set(itemId, cost)
        itemsBefore.set(itemId, amount)
        itemsAfter.set(itemId, amount - cost)
    }

    const manaAfterState = computeManaDeduction({ freeMana, paidMana }, totalManaCost)
    if (manaAfterState === null) {
        throw growthError("INSUFFICIENT_MANA", "player does not have enough mana.")
    }

    return {
        totalManaCost,
        totalItemCosts,
        manaBefore,
        manaAfter: manaAfterState.newFreeMana + manaAfterState.newPaidMana,
        freeManaAfter: manaAfterState.newFreeMana,
        paidManaAfter: manaAfterState.newPaidMana,
        itemsBefore,
        itemsAfter,
    }
}

export function mapToRecord(values: ReadonlyMap<number, number>): Record<string, number> {
    return Object.fromEntries(
        [...values.entries()].sort(([left], [right]) => left - right)
            .map(([id, amount]) => [String(id), amount]),
    )
}
