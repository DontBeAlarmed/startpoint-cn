import {
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import type { InventoryBatchContext } from "./inventory"
import type {
    GenericShopPlayerState,
    GenericShopRewardGrantResult,
} from "./event-shop-purchase"
import type { Reward } from "./types"
import type { PlayerRewardResult } from "./types/rewards"
import { getAwakeFactKeysFromRewardGrants } from "./mission/awake-reward-facts"

export function createShopRewardPlan(
    rewards: readonly Reward[],
): RewardGrantExecutionPlan {
    return createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
}

function projectShopRewardResult(result: RewardGrantExecutionResult): PlayerRewardResult {
    const currency = Object.fromEntries(result.assets.currencies.map(entry => [
        entry.currency,
        entry.requestedAmount,
    ]))
    return {
        user_info: {
            free_mana: currency.freeMana ?? 0,
            free_vmoney: currency.freeVmoney ?? 0,
            exp_pool: currency.expPool ?? 0,
        },
        character_list: result.assets.characters.map(entry => entry.after),
        joined_character_id_list: result.assets.characters
            .filter(entry => entry.joined)
            .map(entry => entry.characterId),
        equipment_list: result.assets.equipment.map(entry => entry.after),
        items: Object.fromEntries(result.assets.items.map(entry => [
            String(entry.itemId),
            entry.afterAmount,
        ])),
    }
}

export function grantShopRewardsInTransactionOwnerWithInventorySync(
    playerId: number,
    rewards: readonly Reward[],
    knownPlayerBefore: GenericShopPlayerState,
    inventory: InventoryBatchContext,
): GenericShopRewardGrantResult {
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
                rewardResult: projectShopRewardResult(result),
                rewardInvalidatedFactKeys: getAwakeFactKeysFromRewardGrants(result),
                playerAfter: {
                    freeMana: result.playerAfter.freeMana,
                    freeVmoney: result.playerAfter.freeVmoney,
                    expPool: result.playerAfter.expPool,
                },
            }
        },
    )
}
