import { createRewardGrantPlan } from "./reward-grant"
import {
    executeRewardGrantPlanInTransactionOwnerWithInventorySync,
} from "./reward-grant/owner-executor"
import type { InventoryBatchContext } from "./inventory"
import type {
    GenericShopPlayerState,
    GenericShopRewardGrantResult,
} from "./event-shop-purchase"
import type { Reward } from "./types"
import type { RewardGrantPlan } from "./reward-grant"
import type { RewardGrantReward } from "./reward-grant/types"

export interface ShopRewardSource {
    readonly rewardIndex: number
}

export function createShopRewardPlan(
    rewards: readonly Reward[],
): RewardGrantPlan<ShopRewardSource> {
    return createRewardGrantPlan(rewards.map((reward, rewardIndex) => ({
        source: { rewardIndex },
        reward: reward as RewardGrantReward,
    })))
}

export function grantShopRewardsInTransactionOwnerWithInventorySync(
    playerId: number,
    rewards: readonly Reward[],
    knownPlayerBefore: GenericShopPlayerState,
    inventory: InventoryBatchContext,
): GenericShopRewardGrantResult {
    const result = executeRewardGrantPlanInTransactionOwnerWithInventorySync(
        playerId,
        createShopRewardPlan(rewards),
        knownPlayerBefore,
        inventory,
    )
    return {
        rewardResult: result.aggregate,
        playerAfter: result.playerAfter,
    }
}
