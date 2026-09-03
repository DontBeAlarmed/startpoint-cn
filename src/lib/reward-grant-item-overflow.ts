import { findItemInventoryPolicy, getItemInventoryPolicyCatalog } from "./inventory/item-inventory-policy"
import { insertItemOverflowMailsWithinTransactionSync } from "./mail-overflow"
import { getVirtualNow } from "../runtime/time/game-time"
import type { RewardGrantItemOverflowPolicy } from "./reward-grant"

export function createRewardGrantItemOverflowPolicy(
    playerId: number,
    now: Date = getVirtualNow(),
): RewardGrantItemOverflowPolicy {
    const catalog = getItemInventoryPolicyCatalog()
    const maxCount = (itemId: number): number => {
            const policy = findItemInventoryPolicy(catalog, itemId)
            if (policy === null) throw new Error(`Item ${itemId} is missing inventory policy.`)
            return policy.maxCount
        }
    return Object.freeze({
        playerId,
        maxCount,
        writeOverflow(itemId: number, amount: number): void {
            insertItemOverflowMailsWithinTransactionSync(
                playerId,
                itemId,
                amount,
                Math.min(maxCount(itemId), 2_147_483_647),
                now,
            )
        },
    })
}
