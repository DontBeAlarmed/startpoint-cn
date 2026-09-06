import { findItemInventoryPolicy, getItemInventoryPolicyCatalog } from "./inventory/item-inventory-policy"
import {
    insertItemOverflowMailsWithinTransactionSync,
    insertManaOverflowMailsWithinTransactionSync,
} from "./mail-overflow"
import { getVirtualNow } from "../runtime/time/game-time"
import type { RewardGrantItemOverflowPolicy } from "./reward-grant"
import { getPlayerSync } from "../data/domains/player"
import { getCurrencyCapacityPolicySync } from "./config-content"
import {
    planItemOverflowDisposition,
    type PlannedItemOverflowDisposition,
} from "./item-overflow/disposition"

export function createRewardGrantItemOverflowPolicy(
    playerId: number,
    now: Date = getVirtualNow(),
    knownPaidMana?: number,
): RewardGrantItemOverflowPolicy {
    const catalog = getItemInventoryPolicyCatalog()
    const maxMana = getCurrencyCapacityPolicySync().maxMana
    let paidMana: number | null = knownPaidMana ?? null
    const policyFor = (itemId: number) => {
        const policy = findItemInventoryPolicy(catalog, itemId)
        if (policy === null) throw new Error(`Item ${itemId} is missing inventory policy.`)
        return policy
    }
    const maxCount = (itemId: number): number => {
        return policyFor(itemId).maxCount
    }
    const getPaidMana = (): number => {
        if (paidMana !== null) return paidMana
        const player = getPlayerSync(playerId)
        if (player === null) throw new Error(`Player ${playerId} is missing during Item overflow.`)
        paidMana = player.paidMana
        return paidMana
    }
    return Object.freeze({
        playerId,
        maxCount,
        planOverflow(
            itemId: number,
            overflowAmount: number,
            currentFreeMana: number,
        ): PlannedItemOverflowDisposition {
            const policy = policyFor(itemId)
            return planItemOverflowDisposition({
                itemId,
                overflowAmount,
                policy,
                freeMana: currentFreeMana,
                paidMana: policy.sellable ? getPaidMana() : 0,
                maxMana: policy.sellable ? maxMana : Number.MAX_SAFE_INTEGER,
            })
        },
        finalizeOverflow(disposition: PlannedItemOverflowDisposition): void {
            if (disposition.kind === "mail") {
                insertItemOverflowMailsWithinTransactionSync(
                    playerId,
                    disposition.itemId,
                    disposition.overflowAmount,
                    Math.min(maxCount(disposition.itemId), 2_147_483_647),
                    now,
                )
                return
            }
            if (disposition.overflowMana > 0) {
                insertManaOverflowMailsWithinTransactionSync(
                    playerId,
                    disposition.overflowMana,
                    Math.max(1, Math.min(maxMana, 2_147_483_647)),
                    now,
                )
            }
        },
    })
}
