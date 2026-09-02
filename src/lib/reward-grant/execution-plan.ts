import { RewardType } from "../types/rewards"
import {
    RewardGrantContractValidationError,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantItemCommand,
} from "./execution-contract"

const ITEM_REWARD_TYPES = new Set<RewardType>([
    RewardType.ITEM,
    RewardType.ELEMENT,
    RewardType.AETHER,
])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveSafeInteger(
    value: unknown,
    entryIndex: number,
    field: "id" | "count",
): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new RewardGrantContractValidationError(entryIndex, field)
    }
    return value
}

function copyCommand(value: unknown, entryIndex: number): RewardGrantCommand {
    if (!isRecord(value)) {
        throw new RewardGrantContractValidationError(entryIndex, "entry")
    }
    const type = value.type
    if (typeof type !== "number" || !Number.isSafeInteger(type)) {
        throw new RewardGrantContractValidationError(entryIndex, "type")
    }
    if (ITEM_REWARD_TYPES.has(type)) {
        return Object.freeze({
            type: type as RewardType.ITEM | RewardType.ELEMENT | RewardType.AETHER,
            id: positiveSafeInteger(value.id, entryIndex, "id"),
            count: positiveSafeInteger(value.count, entryIndex, "count"),
        })
    }
    if (type === RewardType.EQUIPMENT) {
        return Object.freeze({
            type,
            id: positiveSafeInteger(value.id, entryIndex, "id"),
            count: positiveSafeInteger(value.count, entryIndex, "count"),
        })
    }
    if (type === RewardType.CHARACTER) {
        return Object.freeze({
            type,
            id: positiveSafeInteger(value.id, entryIndex, "id"),
        })
    }
    if (type === RewardType.BEADS || type === RewardType.MANA || type === RewardType.EXP) {
        return Object.freeze({
            type,
            count: positiveSafeInteger(value.count, entryIndex, "count"),
        })
    }
    throw new RewardGrantContractValidationError(entryIndex, "type")
}

export function createRewardGrantExecutionPlan(
    entries: readonly RewardGrantCommand[],
): RewardGrantExecutionPlan {
    if (!Array.isArray(entries)) {
        throw new RewardGrantContractValidationError(-1, "entries")
    }
    const copied: RewardGrantCommand[] = []
    for (let index = 0; index < entries.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(entries, index)) {
            throw new RewardGrantContractValidationError(index, "entry")
        }
        copied.push(copyCommand((entries as readonly unknown[])[index], index))
    }
    return Object.freeze({ entries: Object.freeze(copied) })
}

export function requestedRewardGrantAmount(reward: RewardGrantCommand): number {
    return reward.type === RewardType.CHARACTER ? 1 : reward.count
}

export function rewardGrantFingerprint(reward: RewardGrantCommand): string {
    const id = "id" in reward ? reward.id : "-"
    return `${reward.type}:${id}:${requestedRewardGrantAmount(reward)}`
}

export function isItemRewardGrantCommand(
    reward: RewardGrantCommand,
): reward is RewardGrantItemCommand {
    return ITEM_REWARD_TYPES.has(reward.type)
}
