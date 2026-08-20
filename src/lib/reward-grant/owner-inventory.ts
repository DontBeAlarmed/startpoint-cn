import {
    getPlayerItemSync,
    recordPlayerCollectedItemWithinTransactionSync,
    setPlayerItemWithinTransactionSync,
} from "../../data/domains/item"

interface CachedItem {
    readonly hasExistingRow: boolean
    amount: number
    obtained: number
}

/**
 * Coalesces repeated item rewards inside one owner transaction.
 * The cache is deliberately limited to items; character and equipment
 * ownership still use their existing domain writers.
 */
export class OwnerInventoryWriteCache {
    private readonly items = new Map<number, CachedItem>()

    giveItem(playerId: number, itemId: number, amount: number): number {
        let cached = this.items.get(itemId)
        if (cached === undefined) {
            const current = getPlayerItemSync(playerId, itemId)
            cached = {
                hasExistingRow: current !== null,
                amount: current ?? 0,
                obtained: 0,
            }
            this.items.set(itemId, cached)
        }
        cached.amount += amount
        cached.obtained += amount
        return cached.amount
    }

    getItemCount(itemId: number): number | null {
        return this.items.get(itemId)?.amount ?? null
    }

    flush(playerId: number): void {
        for (const [itemId, item] of this.items) {
            setPlayerItemWithinTransactionSync(
                playerId,
                itemId,
                item.amount,
                item.hasExistingRow,
            )
            if (item.obtained > 0) {
                recordPlayerCollectedItemWithinTransactionSync(
                    playerId,
                    itemId,
                    item.obtained,
                )
            }
        }
    }
}
