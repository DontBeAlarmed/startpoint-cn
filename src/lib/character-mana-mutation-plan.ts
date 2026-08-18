import { deepFreeze } from "../content/deep-freeze"
import type {
    AwakeManaNodeMutationInput,
    BaseManaNodeMutationInput,
    LearnManaNodeMutationInput,
    ManaNodeMutationCost,
    ManaNodeMutationPlan,
} from "./character-mana-mutation-types"
import { ManaNodeMutationValidationError } from "./character-mana-mutation-types"
import {
    safeAdd,
    validateAwakeCost,
    validateMutationInput,
} from "./character-mana-mutation-validation"

export { ManaNodeMutationValidationError } from "./character-mana-mutation-types"
export type {
    AwakeManaNodeMutationInput,
    CharacterManaMutationContent,
    CharacterManaMutationSnapshot,
    LearnManaNodeMutationInput,
    ManaNodeMutationPlan,
} from "./character-mana-mutation-types"

interface ResourceSimulation {
    mana: number
    readonly items: Record<string, number>
    totalMana: number
    readonly totalItems: Record<string, number>
}

function orderedRecord(values: Readonly<Record<string, number>>): Record<string, number> {
    return Object.fromEntries(Object.entries(values).sort((left, right) => (
        Number(left[0]) - Number(right[0])
    )))
}

function charge(simulation: ResourceSimulation, cost: ManaNodeMutationCost, nodeId: number): void {
    const totalMana = safeAdd(simulation.totalMana, cost.manaCost, "total mana cost")
    if (simulation.mana < cost.manaCost) {
        throw new ManaNodeMutationValidationError(
            "INSUFFICIENT_MANA",
            `node ${nodeId} exceeds the simulated mana balance`,
        )
    }
    const itemTotals: Array<readonly [string, number]> = []
    for (const [itemId, amount] of Object.entries(cost.items)) {
        const total = safeAdd(simulation.totalItems[itemId] ?? 0, amount, `item ${itemId} cost`)
        if ((simulation.items[itemId] ?? 0) < amount) {
            throw new ManaNodeMutationValidationError(
                "INSUFFICIENT_ITEM",
                `node ${nodeId} exceeds the simulated item ${itemId} balance`,
            )
        }
        itemTotals.push([itemId, total])
    }
    simulation.totalMana = totalMana
    simulation.mana -= cost.manaCost
    for (const [itemId, total] of itemTotals) {
        simulation.totalItems[itemId] = total
        simulation.items[itemId] = (simulation.items[itemId] ?? 0) - cost.items[itemId]
    }
}

function baseState(input: BaseManaNodeMutationInput) {
    const validated = validateMutationInput(input)
    const awakeLevels = new Map(Object.entries(validated.snapshot.nodeAwakeLevels).map(
        ([nodeId, level]) => [Number(nodeId), level] as const,
    ))
    return {
        ...validated,
        awakeLevels,
        learned: new Set(awakeLevels.keys()),
        resources: {
            mana: validated.snapshot.mana,
            items: { ...validated.snapshot.items },
            totalMana: 0,
            totalItems: {},
        } satisfies ResourceSimulation,
    }
}

function assertParent(
    nodeId: number,
    parentId: number | null,
    learned: ReadonlySet<number>,
): void {
    if (parentId !== null && !learned.has(parentId)) {
        throw new ManaNodeMutationValidationError(
            "PARENT_NOT_LEARNED",
            `node ${nodeId} parent ${parentId} is not learned before this request entry`,
        )
    }
}

function finishPlan(
    kind: "learn" | "awake",
    state: ReturnType<typeof baseState>,
    nodeUpdates: Array<{ readonly nodeId: number; readonly awakeLevel: number }>,
    responseNodeEntries: Array<{ readonly multiplied_id: number; readonly awake_level: number }>,
): ManaNodeMutationPlan {
    const finalAwakeLevels = orderedRecord(Object.fromEntries(state.awakeLevels))
    return deepFreeze({
        kind,
        nodeUpdates,
        finalLearnedNodeIds: [...state.learned].sort((left, right) => left - right),
        finalAwakeLevels,
        totalManaCost: state.resources.totalMana,
        totalItemCosts: orderedRecord(state.resources.totalItems),
        remainingMana: state.resources.mana,
        remainingItems: orderedRecord(state.resources.items),
        responseNodeEntries,
        hasResourceWrites: nodeUpdates.length > 0,
    })
}

export function planLearnManaNodeMutation(
    input: LearnManaNodeMutationInput,
): ManaNodeMutationPlan {
    const state = baseState(input)
    const updates: Array<{ nodeId: number; awakeLevel: number }> = []
    const entries: Array<{ multiplied_id: number; awake_level: number }> = []
    for (const nodeId of state.requestedNodeIds) {
        if (state.learned.has(nodeId)) {
            throw new ManaNodeMutationValidationError("ALREADY_LEARNED", `node ${nodeId} is learned`)
        }
        assertParent(nodeId, state.parents[String(nodeId)], state.learned)
        charge(state.resources, state.nodes[String(nodeId)], nodeId)
        state.learned.add(nodeId)
        state.awakeLevels.set(nodeId, 0)
        updates.push({ nodeId, awakeLevel: 0 })
        entries.push({ multiplied_id: nodeId, awake_level: 0 })
    }
    return finishPlan("learn", state, updates, entries)
}

export function planAwakeManaNodeMutation(
    input: AwakeManaNodeMutationInput,
): ManaNodeMutationPlan {
    if (!Number.isSafeInteger(input.targetAwakeLevel) || input.targetAwakeLevel <= 0) {
        throw new ManaNodeMutationValidationError(
            "INVALID_AWAKE_TARGET",
            "target awake level must be a positive safe integer",
        )
    }
    const state = baseState(input)
    const updates: Array<{ nodeId: number; awakeLevel: number }> = []
    const entries: Array<{ multiplied_id: number; awake_level: number }> = []
    for (const nodeId of state.requestedNodeIds) {
        if (!state.learned.has(nodeId)) {
            throw new ManaNodeMutationValidationError("NOT_LEARNED", `node ${nodeId} is not learned`)
        }
        assertParent(nodeId, state.parents[String(nodeId)], state.learned)
        const current = state.awakeLevels.get(nodeId) as number
        if (current > input.targetAwakeLevel) {
            throw new ManaNodeMutationValidationError(
                "INVALID_AWAKE_TARGET",
                `node ${nodeId} is already above target awake level`,
            )
        }
        if (current < input.targetAwakeLevel) {
            charge(
                state.resources,
                validateAwakeCost(input.awakeCosts?.[String(nodeId)], nodeId),
                nodeId,
            )
            state.awakeLevels.set(nodeId, input.targetAwakeLevel)
            updates.push({ nodeId, awakeLevel: input.targetAwakeLevel })
        }
        entries.push({ multiplied_id: nodeId, awake_level: input.targetAwakeLevel })
    }
    return finishPlan("awake", state, updates, entries)
}
