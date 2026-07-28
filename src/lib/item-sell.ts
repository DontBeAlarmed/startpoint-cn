import { getItemSaleSync } from "./assets";
import { countAbilitySoulUsedInPartiesSync } from "../data/domains/party"
import { getPlayerItemSync, updatePlayerItemSync } from "../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { getConfigSync } from "./assets";
import { getDb } from "../data/db";

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
 * - Ability souls in use by parties cannot be sold
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

        // Check ownership
        const ownedCount = getPlayerItemSync(playerId, itemId) ?? 0
        if (ownedCount < sellNumber) {
            return { ok: false, error: "Not enough items owned." }
        }

        // Ability soul check: cannot sell souls equipped in parties
        if (saleData.category === 5) {
            const usedInParties = countAbilitySoulUsedInPartiesSync(playerId, itemId)
            const sellable = ownedCount - usedInParties
            if (sellable < sellNumber) {
                return { ok: false, error: "Some ability souls are in use. Cannot sell more than available." }
            }
        }

        // Check mana limit
        const player = getPlayerSync(playerId)
        if (!player) return { ok: false, error: "Player not found." }

        const manaGained = saleData.sale_price * sellNumber
        const config = getConfigSync()
        const maxMana = config.max_mana ?? 99999999
        if (player.freeMana + manaGained > maxMana) {
            return { ok: false, errorCode: 2102, error: "Mana would exceed maximum." }
        }

        // Deduct item
        const newCount = ownedCount - sellNumber
        updatePlayerItemSync(playerId, itemId, newCount)

        // Add mana
        const newMana = player.freeMana + manaGained
        updatePlayerSync({ id: playerId, freeMana: newMana, totalManaObtained: (player.totalManaObtained ?? 0) + manaGained })

        return { ok: true, newCount, freeMana: newMana, manaGained }
    })()
}
