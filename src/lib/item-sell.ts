import { getItemSaleSync } from "./item-content";
import { getCurrencyCapacityPolicySync } from "./config-content"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { getDb } from "../data/db";
import { withInventoryBatchContextWithinTransactionSync } from "./inventory"

const ABILITY_SOUL_RESERVED_COUNT = 3

export type ItemSellResult =
    | {
        ok: true;
        newCount: number;
        freeMana: number;
        manaGained: number;
    }
    | {
        ok: false;
        errorCode?: number;
        error: string;
    };

/**
 * Sell items for mana. Performs server-side validation:
 * - Item must be sellable (CDN sellable=true)
 * - Player must own enough items
 * - Ability soul sales must preserve the three copies protected by the client
 * - Mana must not overflow max_mana
 */
export function sellItemSync(
    playerId: number,
    itemId: number,
    sellNumber: number
): ItemSellResult {
    return getDb().transaction((): ItemSellResult => {
        // Validate sell number
        if (!Number.isInteger(sellNumber) || sellNumber <= 0) {
            return { ok: false, error: "Invalid sell number." }
        }

        // Look up item sale data
        const saleData = getItemSaleSync(itemId)
        if (!saleData) {
            return { ok: false, error: "Item not found in sale data." }
        }
        if (!saleData.sellable) {
            return { ok: false, error: "This item cannot be sold." }
        }

        const player = getPlayerSync(playerId)
        if (!player) return { ok: false, error: "Player not found." }

        return withInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [itemId],
        }, inventory => {
            const ownedCount = inventory.read(itemId).beforeAmount
            if (ownedCount < sellNumber) {
                return { ok: false, error: "Not enough items owned." }
            }

            if (saleData.category === 5
                && ownedCount - sellNumber < ABILITY_SOUL_RESERVED_COUNT) {
                return { ok: false, error: "At least three ability souls must remain." }
            }

            // Check mana limit
            const manaGained = saleData.sale_price * sellNumber
            const maxMana = getCurrencyCapacityPolicySync().maxMana
            if (player.freeMana + manaGained > maxMana) {
                return { ok: false, errorCode: 2102, error: "Mana would exceed maximum." }
            }

            inventory.deduct(itemId, sellNumber)
            const [itemResult] = inventory.flush()
            if (itemResult === undefined) throw new Error("Item sale did not produce an inventory result.")

            const newMana = player.freeMana + manaGained
            updatePlayerSync({
                id: playerId,
                freeMana: newMana,
                totalManaObtained: (player.totalManaObtained ?? 0) + manaGained,
            })

            return {
                ok: true,
                newCount: itemResult.afterAmount,
                freeMana: newMana,
                manaGained,
            }
        })
    })()
}
