import { RewardType } from "../types/rewards"
import { RewardGrantEntry, RewardGrantPlan, RewardGrantReward } from "./types"

export type RewardGrantPlanField = "entries" | "entry" | "reward" | "name" | "type" | "id" | "count"

export class RewardGrantPlanValidationError extends Error {
    readonly entryIndex: number
    readonly field: RewardGrantPlanField

    constructor(entryIndex: number, field: RewardGrantPlanField) {
        super(`Invalid reward grant entry at index ${entryIndex}: ${field}`)
        this.name = "RewardGrantPlanValidationError"
        this.entryIndex = entryIndex
        this.field = field
    }
}

const ID_REWARD_TYPES = new Set<RewardType>([
    RewardType.ITEM,
    RewardType.EQUIPMENT,
    RewardType.CHARACTER,
    RewardType.ELEMENT,
    RewardType.AETHER,
])

const KNOWN_REWARD_TYPES = new Set<RewardType>(Object.values(RewardType)
    .filter((value): value is RewardType => typeof value === "number"))

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isKnownRewardType(value: unknown): value is RewardType {
    return typeof value === "number" && KNOWN_REWARD_TYPES.has(value)
}

function isCountOnlyRewardType(
    value: RewardType,
): value is RewardType.BEADS | RewardType.MANA | RewardType.EXP {
    return value === RewardType.BEADS
        || value === RewardType.MANA
        || value === RewardType.EXP
}

function freezeRewardSnapshot(values: RewardGrantReward): RewardGrantReward {
    return Object.freeze(values)
}

function copyValidatedReward(
    reward: Record<string, unknown>,
    entryIndex: number,
): RewardGrantReward {
    const type = reward.type
    if (!isKnownRewardType(type)) {
        throw new RewardGrantPlanValidationError(entryIndex, "type")
    }
    const name = reward.name
    if (name !== undefined && typeof name !== "string") {
        throw new RewardGrantPlanValidationError(entryIndex, "name")
    }

    if (type === RewardType.CHARACTER) {
        const id = reward.id
        if (!isPositiveSafeInteger(id)) {
            throw new RewardGrantPlanValidationError(entryIndex, "id")
        }
        return freezeRewardSnapshot(name === undefined
            ? { type, id }
            : { name, type, id })
    }
    if (ID_REWARD_TYPES.has(type)) {
        const id = reward.id
        if (!isPositiveSafeInteger(id)) {
            throw new RewardGrantPlanValidationError(entryIndex, "id")
        }
        const count = reward.count
        if (!isPositiveSafeInteger(count)) {
            throw new RewardGrantPlanValidationError(entryIndex, "count")
        }
        return freezeRewardSnapshot(name === undefined
            ? { type, id, count }
            : { name, type, id, count })
    }

    if (!isCountOnlyRewardType(type)) {
        throw new RewardGrantPlanValidationError(entryIndex, "count")
    }
    const count = reward.count
    if (!isPositiveSafeInteger(count)) {
        throw new RewardGrantPlanValidationError(entryIndex, "count")
    }
    return freezeRewardSnapshot(name === undefined
        ? { type, count }
        : { name, type, count })
}

export function createRewardGrantPlan<TSource>(
    entries: readonly RewardGrantEntry<TSource>[],
): RewardGrantPlan<TSource> {
    if (!Array.isArray(entries)) {
        throw new RewardGrantPlanValidationError(-1, "entries")
    }

    const runtimeEntries: readonly unknown[] = entries
    const capturedEntries: Array<{
        source: TSource
        reward: Record<string, unknown>
    }> = []
    for (let entryIndex = 0; entryIndex < runtimeEntries.length; entryIndex++) {
        const entry = runtimeEntries[entryIndex]
        if (!isRecord(entry)) {
            throw new RewardGrantPlanValidationError(entryIndex, "entry")
        }
        const reward = entry.reward
        if (!isRecord(reward)) {
            throw new RewardGrantPlanValidationError(entryIndex, "reward")
        }
        capturedEntries.push({
            source: entry.source as TSource,
            reward,
        })
    }

    const copiedEntries = capturedEntries.map((entry, entryIndex) => Object.freeze({
        source: entry.source,
        reward: copyValidatedReward(entry.reward, entryIndex),
    }))
    return Object.freeze({ entries: Object.freeze(copiedEntries) })
}
