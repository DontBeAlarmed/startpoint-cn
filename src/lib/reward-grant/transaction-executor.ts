import { getDb } from "../../data/db"
import { getPlayerSync } from "../../data/domains/player"
import {
    withDeferredInventoryBatchContextWithinTransactionSync,
    getInventoryBatchCheckpoint,
    type InventoryBatchContext,
} from "../inventory"
import { RewardType } from "../types/rewards"
import {
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
    type RewardGrantKnownPlayerState,
} from "./execution-contract"
import {
    prepareRewardGrantExecution,
    type PreparedRewardGrantExecution,
} from "./execution-engine"
import { normalizeRewardGrantKnownPlayerState } from "./execution-outcome"
import { normalizeRewardGrantExecutionPlan } from "./execution-plan"

export type RewardGrantExecutionTransactionReason =
    | "TRANSACTION_REQUIRED"
    | "ACTIVE_TRANSACTION_NOT_ALLOWED"
    | "PLAYER_NOT_FOUND"
    | "FINALIZATION_REQUIRED"
    | "ALREADY_FINALIZED"
    | "INVENTORY_PLAYER_MISMATCH"
    | "INVENTORY_CHANGED_AFTER_GRANT"

export class RewardGrantExecutionTransactionError extends Error {
    readonly reason: RewardGrantExecutionTransactionReason

    constructor(reason: RewardGrantExecutionTransactionReason) {
        super(`RewardGrant execution transaction error: ${reason}`)
        this.name = "RewardGrantExecutionTransactionError"
        this.reason = reason
    }
}

export interface RewardGrantExternalFinalization {
    readonly result: RewardGrantExecutionResult
    finalize(): RewardGrantExecutionResult
}

export function assertRewardGrantExecutionTransactionOwnerSync(): void {
    if (!getDb().inTransaction) {
        throw new RewardGrantExecutionTransactionError("TRANSACTION_REQUIRED")
    }
}

function directItemIds(plan: RewardGrantExecutionPlan): number[] {
    return [...new Set(plan.entries.flatMap(entry => {
        switch (entry.type) {
            case RewardType.ITEM:
            case RewardType.ELEMENT:
            case RewardType.AETHER:
                return [entry.id]
            default:
                return []
        }
    }))]
}

function playerState(playerId: number): RewardGrantKnownPlayerState {
    const player = getPlayerSync(playerId)
    if (player === null) {
        throw new RewardGrantExecutionTransactionError("PLAYER_NOT_FOUND")
    }
    return {
        playerId,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
}

function finalizeOwnedExecution(
    prepared: PreparedRewardGrantExecution,
    inventory: InventoryBatchContext,
): RewardGrantExecutionResult {
    const checkpoint = getInventoryBatchCheckpoint(inventory)
    if (checkpoint.playerId !== prepared.inventoryCheckpoint.playerId
        || checkpoint.revision !== prepared.inventoryCheckpoint.revision) {
        throw new RewardGrantExecutionTransactionError("INVENTORY_CHANGED_AFTER_GRANT")
    }
    inventory.flush()
    prepared.persistPlayerResources()
    return prepared.result
}

function executeWithOwnedInventory(
    playerId: number,
    plan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
): RewardGrantExecutionResult {
    return withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: directItemIds(plan),
        playerExistence: "caller-verified",
    }, inventory => finalizeOwnedExecution(
        prepareRewardGrantExecution(playerId, plan, knownPlayerBefore, inventory),
        inventory,
    ))
}

export function executeRewardGrantExecutionPlanSync(
    playerId: number,
    rawPlan: RewardGrantExecutionPlan,
): RewardGrantExecutionResult {
    const db = getDb()
    if (db.inTransaction) {
        throw new RewardGrantExecutionTransactionError("ACTIVE_TRANSACTION_NOT_ALLOWED")
    }
    const plan = normalizeRewardGrantExecutionPlan(rawPlan)
    return db.transaction(() => executeWithOwnedInventory(
        playerId,
        plan,
        playerState(playerId),
    ))()
}

export function executeRewardGrantExecutionPlanWithinTransactionSync(
    playerId: number,
    rawPlan: RewardGrantExecutionPlan,
): RewardGrantExecutionResult {
    const db = getDb()
    if (!db.inTransaction) {
        throw new RewardGrantExecutionTransactionError("TRANSACTION_REQUIRED")
    }
    const plan = normalizeRewardGrantExecutionPlan(rawPlan)
    return db.transaction(() => executeWithOwnedInventory(
        playerId,
        plan,
        playerState(playerId),
    ))()
}

export function executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId: number,
    rawPlan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
): RewardGrantExecutionResult {
    if (!getDb().inTransaction) {
        throw new RewardGrantExecutionTransactionError("TRANSACTION_REQUIRED")
    }
    const plan = normalizeRewardGrantExecutionPlan(rawPlan)
    const known = normalizeRewardGrantKnownPlayerState(playerId, knownPlayerBefore)
    return executeWithOwnedInventory(playerId, plan, known)
}

export function withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync<T>(
    playerId: number,
    rawPlan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
    inventory: InventoryBatchContext,
    callback: (execution: RewardGrantExternalFinalization) => T,
): T {
    if (!getDb().inTransaction) {
        throw new RewardGrantExecutionTransactionError("TRANSACTION_REQUIRED")
    }
    if (typeof callback !== "function") throw new TypeError("RewardGrant finalization callback required")
    const plan = normalizeRewardGrantExecutionPlan(rawPlan)
    const known = normalizeRewardGrantKnownPlayerState(playerId, knownPlayerBefore)
    const checkpoint = getInventoryBatchCheckpoint(inventory)
    if (checkpoint.playerId !== playerId) {
        throw new RewardGrantExecutionTransactionError("INVENTORY_PLAYER_MISMATCH")
    }
    const prepared = prepareRewardGrantExecution(playerId, plan, known, inventory)
    let finalized = false
    const execution = Object.freeze({
        result: prepared.result,
        finalize(): RewardGrantExecutionResult {
            if (finalized) {
                throw new RewardGrantExecutionTransactionError("ALREADY_FINALIZED")
            }
            const result = finalizeOwnedExecution(prepared, inventory)
            finalized = true
            return result
        },
    })
    const output = callback(execution)
    if (!finalized) {
        throw new RewardGrantExecutionTransactionError("FINALIZATION_REQUIRED")
    }
    return output
}
