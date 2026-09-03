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
import type {
    GenericShopPlayerState,
    GenericShopRewardGrantResult,
} from "./event-shop-purchase"
import type { Reward } from "./types"
import type { PlayerRewardResult } from "./types/rewards"
import type { FactKey } from "./mission/facts/fact-key"
import type { PlannedItemOverflowDisposition } from "./item-overflow"
import { getAwakeFactKeysFromRewardGrants } from "./mission/awake-reward-facts"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"

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
        itemOverflowDispositions: collectRewardGrantItemOverflowDispositions(result),
    }
}

export function grantShopRewardsInTransactionOwnerWithInventorySync(
    playerId: number,
    rewards: readonly Reward[],
    knownPlayerBefore: GenericShopPlayerState,
    inventory: InventoryBatchContext,
    options: {
        readonly virtualNow?: Date
        readonly knownPaidMana?: number
    } = {},
): GenericShopRewardGrantResult {
    const typed = grantShopRewardsTypedInTransactionOwnerWithInventorySync(
        playerId,
        rewards,
        knownPlayerBefore,
        inventory,
        options,
    )
    return {
        rewardResult: projectShopRewardResult(typed.execution),
        rewardInvalidatedFactKeys: typed.invalidatedFactKeys,
        playerAfter: {
            freeMana: typed.execution.playerAfter.freeMana,
            freeVmoney: typed.execution.playerAfter.freeVmoney,
            expPool: typed.execution.playerAfter.expPool,
        },
    }
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
