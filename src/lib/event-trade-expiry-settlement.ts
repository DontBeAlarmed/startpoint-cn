import { getDb } from "../data/db"
import { getPlayerItemsByIdsSync } from "../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { expireInventoryItemsWithinTransactionSync } from "./inventory"
import {
    getItemInventoryPolicyCatalog,
    type ItemInventoryPolicyCatalog,
} from "./inventory/item-inventory-policy"
import {
    planEventTradeExpiry,
    type EventTradeExpiryEntry,
} from "./inventory/event-trade-expiry-plan"
import { planManaCapacity } from "./inventory/mana-capacity-plan"
import { insertManaOverflowMailsWithinTransactionSync } from "./mail-overflow"

interface EventTradeExpirySettlementInput {
    readonly playerId: number
    readonly player: {
        readonly id: number
        readonly freeMana: number
        readonly paidMana: number
        readonly totalManaObtained: number
    }
    readonly nowMs: number
    readonly maxMana: number
    readonly catalog?: ItemInventoryPolicyCatalog
}

export type EventTradeExpirySettlementResult =
    | {
        readonly status: "none"
    }
    | {
        readonly status: "converted"
        readonly entries: readonly EventTradeExpiryEntry[]
        readonly totalMana: number
        readonly acceptedMana: number
        readonly overflowMana?: number
    }

function requirePlayerId(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError("playerId must be a positive safe integer")
    }
}

function requireSafeAmount(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value
}

function addSafe(left: number, right: number, field: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${field} exceeds the safe integer range`)
    }
    return result
}

export function settleEventTradeExpiryOnLoadSync(
    input: EventTradeExpirySettlementInput,
): EventTradeExpirySettlementResult {
    requirePlayerId(input.playerId)
    if (input.player.id !== input.playerId) {
        throw new TypeError("player.id must match playerId")
    }

    const catalog = input.catalog ?? getItemInventoryPolicyCatalog()
    const ownedItems = getPlayerItemsByIdsSync(input.playerId, catalog.eventTradeItemIds)
    const expiryPlan = planEventTradeExpiry(
        Object.entries(ownedItems).map(([itemId, amount]) => ({
            itemId: Number(itemId),
            amount,
        })),
        catalog,
        input.nowMs,
    )
    if (expiryPlan.entries.length === 0) return { status: "none" }

    return getDb().transaction(() => {
        const currentPlayer = getPlayerSync(input.playerId)
        if (currentPlayer === null) {
            throw new Error("No player data during EventTrade expiry settlement.")
        }
        const capacity = planManaCapacity({
            freeMana: currentPlayer.freeMana,
            paidMana: currentPlayer.paidMana,
            maxMana: input.maxMana,
            requestedMana: expiryPlan.totalMana,
        })
        const currentTotalManaObtained = requireSafeAmount(
            currentPlayer.totalManaObtained ?? 0,
            "totalManaObtained",
        )
        const nextTotalManaObtained = addSafe(
            currentTotalManaObtained,
            capacity.acceptedMana,
            "totalManaObtained",
        )
        expireInventoryItemsWithinTransactionSync(
            input.playerId,
            expiryPlan.entries.map(entry => ({
                itemId: entry.itemId,
                amount: entry.amount,
            })),
        )
        updatePlayerSync({
            id: input.playerId,
            freeMana: currentPlayer.freeMana + capacity.acceptedMana,
            totalManaObtained: nextTotalManaObtained,
        })
        if (capacity.overflowMana > 0) {
            const maxAttachmentNumber = Math.max(
                1,
                Math.min(input.maxMana, 2_147_483_647),
            )
            insertManaOverflowMailsWithinTransactionSync(
                input.playerId,
                capacity.overflowMana,
                maxAttachmentNumber,
                new Date(input.nowMs),
            )
        }
        return Object.freeze({
            status: "converted" as const,
            entries: expiryPlan.entries,
            totalMana: expiryPlan.totalMana,
            acceptedMana: capacity.acceptedMana,
            ...(capacity.overflowMana > 0 ? { overflowMana: capacity.overflowMana } : {}),
        })
    })()
}
