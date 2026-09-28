import {
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    collectRewardGrantItemOverflowDispositions,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import type { InventoryBatchContext } from "./inventory"
import type { Reward } from "./types"
import type { FactKey } from "./mission/facts/fact-key"
import type { PlannedItemOverflowDisposition } from "./item-overflow"
import { getAwakeFactKeysFromRewardGrants } from "./mission/awake-reward-facts"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"

export function createShopRewardPlan(
    rewards: readonly Reward[],
): RewardGrantExecutionPlan {
    return createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
}

export interface ShopTypedRewardPlayerBefore {
    readonly id: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface ShopTypedRewardGrantResult {
    readonly execution: RewardGrantExecutionResult
    readonly invalidatedFactKeys: readonly FactKey[]
    readonly itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
}

export function grantShopRewardsTypedInTransactionOwnerWithInventorySync(
    playerId: number,
    rewards: readonly Reward[],
    knownPlayerBefore: ShopTypedRewardPlayerBefore,
    inventory: InventoryBatchContext,
    options: {
        readonly virtualNow?: Date
        readonly knownPaidMana?: number
    } = {},
): ShopTypedRewardGrantResult {
    const plan = createShopRewardPlan(rewards)
    return withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            playerId: knownPlayerBefore.id,
            freeMana: knownPlayerBefore.freeMana,
            freeVmoney: knownPlayerBefore.freeVmoney,
            expPool: knownPlayerBefore.expPool,
        },
        inventory,
        execution => {
            const result = snapshotRewardGrantExecutionResultForPlan(
                playerId,
                plan,
                execution.result,
            )
            execution.finalize()
            return {
                execution: result,
                invalidatedFactKeys: getAwakeFactKeysFromRewardGrants(result),
                itemOverflowDispositions: collectRewardGrantItemOverflowDispositions(result),
            }
        },
        {
            itemOverflow: createRewardGrantItemOverflowPolicy(
                playerId,
                options.virtualNow,
                options.knownPaidMana,
            ),
        },
    )
}
