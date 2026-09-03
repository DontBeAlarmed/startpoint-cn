import { findItemInventoryPolicy, getItemInventoryPolicyCatalog } from "./inventory/item-inventory-policy"
import { insertItemOverflowMailWithinTransactionSync } from "./mail-overflow"
import { getVirtualNow } from "../runtime/time/game-time"
import type { RewardGrantItemOverflowPolicy } from "./reward-grant"

export function createRewardGrantItemOverflowPolicy(
    playerId: number,
    now: Date = getVirtualNow(),
): RewardGrantItemOverflowPolicy {
    const catalog = getItemInventoryPolicyCatalog()
    return Object.freeze({
        playerId,
        maxCount(itemId: number): number {
            const policy = findItemInventoryPolicy(catalog, itemId)
            if (policy === null) throw new Error(`Item ${itemId} is missing inventory policy.`)
            return policy.maxCount
        },
        writeOverflow(itemId: number, amount: number): void {
            insertItemOverflowMailWithinTransactionSync(playerId, itemId, amount, now)
        },
    })
}
