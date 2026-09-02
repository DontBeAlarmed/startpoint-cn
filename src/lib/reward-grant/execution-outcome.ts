import { RewardType } from "../types/rewards"
import {
    RewardGrantContractValidationError,
    type RewardGrantCommand,
    type RewardGrantCurrencyKind,
    type RewardGrantEntryOutcome,
    type RewardGrantItemOutcome,
    type RewardGrantKnownPlayerState,
} from "./execution-contract"
import {
    isItemRewardGrantCommand,
    requestedRewardGrantAmount,
} from "./execution-plan"
import { copyRewardGrantObjectSnapshot } from "./snapshot"

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function addRewardGrantAmount(
    left: number,
    right: number,
    entryIndex: number,
    field: "requestedAmount" | "acceptedAmount" | "overflowAmount",
): number {
    const result = left + right
    if (!Number.isSafeInteger(result)) {
        throw new RewardGrantContractValidationError(entryIndex, field)
    }
    return result
}

function amount(
    value: unknown,
    entryIndex: number,
    field: "requestedAmount" | "acceptedAmount" | "overflowAmount" | "beforeAmount" | "afterAmount",
    positive = false,
): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)
        || value < (positive ? 1 : 0)) {
        throw new RewardGrantContractValidationError(entryIndex, field)
    }
    return value
}

function positiveId(
    value: unknown,
    entryIndex: number,
    field: "id" | "playerId" = "id",
): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new RewardGrantContractValidationError(entryIndex, field)
    }
    return value
}

export function normalizeRewardGrantItemOutcome(
    value: unknown,
    entryIndex: number,
): RewardGrantItemOutcome {
    if (!isRecord(value)) throw new RewardGrantContractValidationError(entryIndex, "item")
    const itemId = positiveId(value.itemId, entryIndex)
    const requestedAmount = amount(value.requestedAmount, entryIndex, "requestedAmount", true)
    const acceptedAmount = amount(value.acceptedAmount, entryIndex, "acceptedAmount")
    const overflowAmount = amount(value.overflowAmount, entryIndex, "overflowAmount")
    const beforeAmount = amount(value.beforeAmount, entryIndex, "beforeAmount")
    const afterAmount = amount(value.afterAmount, entryIndex, "afterAmount")
    const expectedAfter = beforeAmount + acceptedAmount
    if (addRewardGrantAmount(
        acceptedAmount,
        overflowAmount,
        entryIndex,
        "requestedAmount",
    ) !== requestedAmount || !Number.isSafeInteger(expectedAfter) || expectedAfter !== afterAmount) {
        throw new RewardGrantContractValidationError(entryIndex, "afterAmount")
    }
    return Object.freeze({
        itemId,
        requestedAmount,
        acceptedAmount,
        overflowAmount,
        beforeAmount,
        afterAmount,
    })
}

function currencyForReward(reward: RewardGrantCommand): RewardGrantCurrencyKind | null {
    switch (reward.type) {
        case RewardType.BEADS: return "freeVmoney"
        case RewardType.MANA: return "freeMana"
        case RewardType.EXP: return "expPool"
        default: return null
    }
}

export function normalizeRewardGrantEntryOutcome(
    reward: RewardGrantCommand,
    value: unknown,
    entryIndex: number,
): RewardGrantEntryOutcome {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw new RewardGrantContractValidationError(entryIndex, "outcome")
    }
    if (isItemRewardGrantCommand(reward)) {
        if (value.kind !== "item") throw new RewardGrantContractValidationError(entryIndex, "outcome")
        const item = normalizeRewardGrantItemOutcome(value.item, entryIndex)
        if (item.itemId !== reward.id || item.requestedAmount !== reward.count) {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        return Object.freeze({ kind: "item", item })
    }
    if (reward.type === RewardType.CHARACTER) {
        if (value.kind !== "character") {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        const characterId = positiveId(value.characterId, entryIndex)
        if (characterId !== reward.id || typeof value.isNew !== "boolean") {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        const compensationItem = value.compensationItem === null
            ? null
            : normalizeRewardGrantItemOutcome(value.compensationItem, entryIndex)
        if (value.isNew && compensationItem !== null) {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        return Object.freeze({
            kind: "character",
            characterId,
            isNew: value.isNew,
            after: copyRewardGrantObjectSnapshot(value.after, entryIndex),
            compensationItem,
        })
    }
    if (reward.type === RewardType.EQUIPMENT) {
        if (value.kind !== "equipment") {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        const equipmentId = positiveId(value.equipmentId, entryIndex)
        const requestedAmount = amount(
            value.requestedAmount,
            entryIndex,
            "requestedAmount",
            true,
        )
        if (equipmentId !== reward.id || requestedAmount !== reward.count) {
            throw new RewardGrantContractValidationError(entryIndex, "outcome")
        }
        return Object.freeze({
            kind: "equipment",
            equipmentId,
            requestedAmount,
            after: copyRewardGrantObjectSnapshot(value.after, entryIndex),
        })
    }
    const currency = currencyForReward(reward)
    if (currency === null || value.kind !== "currency" || value.currency !== currency) {
        throw new RewardGrantContractValidationError(entryIndex, "outcome")
    }
    const requestedAmount = amount(value.requestedAmount, entryIndex, "requestedAmount", true)
    const beforeAmount = amount(value.beforeAmount, entryIndex, "beforeAmount")
    const afterAmount = amount(value.afterAmount, entryIndex, "afterAmount")
    const expectedAfter = beforeAmount + requestedAmount
    if (requestedAmount !== requestedRewardGrantAmount(reward)
        || !Number.isSafeInteger(expectedAfter) || expectedAfter !== afterAmount) {
        throw new RewardGrantContractValidationError(entryIndex, "afterAmount")
    }
    return Object.freeze({
        kind: "currency",
        currency,
        requestedAmount,
        beforeAmount,
        afterAmount,
    })
}

export function normalizeRewardGrantKnownPlayerState(
    expectedPlayerId: number,
    value: unknown,
): RewardGrantKnownPlayerState {
    const trustedPlayerId = positiveId(expectedPlayerId, -1, "playerId")
    if (!isRecord(value)) throw new RewardGrantContractValidationError(-1, "playerAfter")
    const playerId = positiveId(value.playerId, -1, "playerId")
    if (playerId !== trustedPlayerId) {
        throw new RewardGrantContractValidationError(-1, "playerId")
    }
    return Object.freeze({
        playerId,
        freeMana: amount(value.freeMana, -1, "afterAmount"),
        freeVmoney: amount(value.freeVmoney, -1, "afterAmount"),
        expPool: amount(value.expPool, -1, "afterAmount"),
    })
}
