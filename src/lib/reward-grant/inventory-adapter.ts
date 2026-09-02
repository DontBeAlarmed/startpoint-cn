import {
    withDeferredInventoryBatchContextWithinTransactionSync,
    type InventoryBatchContext,
} from "../inventory"
import { RewardType } from "../types/rewards"
import type { RewardGrantPlan } from "./types"

export interface RewardGrantInventoryBatch {
    grant(itemId: number, amount: number): number
    readGranted(itemId: number): number | null
    flush(): void
}

export function withExternalRewardGrantInventoryBatchSync<TResult>(
    context: InventoryBatchContext,
    callback: (inventory: RewardGrantInventoryBatch) => TResult,
): TResult {
    const grantedItemIds = new Set<number>()
    return callback({
        grant(itemId, amount) {
            const result = context.grant(itemId, amount)
            grantedItemIds.add(itemId)
            return result.afterAmount
        },
        readGranted(itemId) {
            return grantedItemIds.has(itemId) ? context.read(itemId).afterAmount : null
        },
        flush() {
            context.flush()
        },
    })
}

function directRewardItemIds<TSource>(plan: RewardGrantPlan<TSource>): number[] {
    return [...new Set(plan.entries.flatMap(entry => {
        switch (entry.reward.type) {
            case RewardType.ITEM:
            case RewardType.ELEMENT:
            case RewardType.AETHER:
                return [entry.reward.id]
            default:
                return []
        }
    }))]
}

/** RewardGrant adapter; Inventory remains the only Item state owner. */
export function withRewardGrantInventoryBatchSync<TSource, TResult>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    callback: (inventory: RewardGrantInventoryBatch) => TResult,
): TResult {
    return withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: directRewardItemIds(plan),
        playerExistence: "caller-verified",
    }, context => {
        let activated = false
        return callback({
            grant(itemId, amount) {
                activated = true
                return context.grant(itemId, amount).afterAmount
            },
            readGranted(itemId) {
                return activated ? context.read(itemId).afterAmount : null
            },
            flush() {
                if (activated) context.flush()
            },
        })
    })
}
