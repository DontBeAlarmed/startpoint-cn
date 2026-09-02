import { getDb } from "../../data/db"
import {
    projectPublicRewardGrantResult,
    type InternalRewardGrantResult,
} from "./entry-result"
import {
    executeNormalizedRewardGrantPlanAsTransactionOwnerInternalSync,
    executeNormalizedRewardGrantPlanAsTransactionOwnerWithExternalInventoryInternalSync,
    normalizeRewardGrantPlanInternal,
    RewardGrantTransactionRequiredError,
} from "./executor"
import type { InventoryBatchContext } from "../inventory"
import { snapshotKnownRewardGrantPlayer } from "./known-player"
import type { RewardGrantOwnerPlayerUpdate } from "./owner-currency"
import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
} from "./types"

export function assertRewardGrantTransactionOwnerSync(): void {
    if (!getDb().inTransaction) throw new RewardGrantTransactionRequiredError()
}

/**
 * Internal Score-only detail path. Keep direct imports named Internal and out of the barrel.
 */
export function executeRewardGrantPlanInTransactionOwnerInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): InternalRewardGrantResult<TSource> {
    assertRewardGrantTransactionOwnerSync()
    return executeNormalizedRewardGrantPlanAsTransactionOwnerInternalSync(
        playerId,
        normalizeRewardGrantPlanInternal(plan),
        snapshotKnownRewardGrantPlayer(knownPlayerBefore),
        playerUpdate,
    )
}

export function executeRewardGrantPlanInTransactionOwnerSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): RewardGrantResult<TSource> {
    return projectPublicRewardGrantResult(
        executeRewardGrantPlanInTransactionOwnerInternalSync(
            playerId,
            plan,
            knownPlayerBefore,
            playerUpdate,
        ),
    )
}

export function executeRewardGrantPlanInTransactionOwnerWithInventorySync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    inventory: InventoryBatchContext,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): RewardGrantResult<TSource> {
    return projectPublicRewardGrantResult(
        executeRewardGrantPlanInTransactionOwnerWithInventoryInternalSync(
            playerId,
            plan,
            knownPlayerBefore,
            inventory,
            playerUpdate,
        ),
    )
}

/**
 * Internal source-owner path for projections that require per-entry Item deltas.
 * The caller remains the transaction and Inventory owner.
 */
export function executeRewardGrantPlanInTransactionOwnerWithInventoryInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    inventory: InventoryBatchContext,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): InternalRewardGrantResult<TSource> {
    assertRewardGrantTransactionOwnerSync()
    return executeNormalizedRewardGrantPlanAsTransactionOwnerWithExternalInventoryInternalSync(
        playerId,
        normalizeRewardGrantPlanInternal(plan),
        snapshotKnownRewardGrantPlayer(knownPlayerBefore),
        inventory,
        playerUpdate,
    )
}
