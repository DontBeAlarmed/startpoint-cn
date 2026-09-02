import { getDb } from "../../data/db"
import {
    projectPublicRewardGrantResult,
    type InternalRewardGrantResult,
} from "./entry-result"
import {
    executeNormalizedRewardGrantPlanAsTransactionOwnerInternalSync,
    normalizeRewardGrantPlanInternal,
    RewardGrantTransactionRequiredError,
} from "./executor"
import { snapshotKnownRewardGrantPlayer } from "./known-player"
import type { RewardGrantOwnerPlayerUpdate } from "./owner-currency"
import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
} from "./types"

/**
 * Internal Score-only detail path. Keep direct imports named Internal and out of the barrel.
 */
export function executeRewardGrantPlanInTransactionOwnerInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): InternalRewardGrantResult<TSource> {
    const db = getDb()
    if (!db.inTransaction) throw new RewardGrantTransactionRequiredError()
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
