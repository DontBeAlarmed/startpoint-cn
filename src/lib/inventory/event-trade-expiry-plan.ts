import { deepFreeze } from "../../content/deep-freeze"
import type { ItemInventoryPolicyCatalog } from "./item-inventory-policy"

export interface OwnedItemAmount {
    readonly itemId: number
    readonly amount: number
}

export interface EventTradeExpiryEntry {
    readonly itemId: number
    readonly amount: number
    readonly salePrice: number
    readonly mana: number
}

export interface EventTradeExpiryPlan {
    readonly entries: readonly EventTradeExpiryEntry[]
    readonly totalMana: number
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`)
    }
    return value
}

export function isEventTradeExpiredAt(nowMs: number, endTimeMs: number): boolean {
    requireNonNegativeSafeInteger(nowMs, "nowMs")
    requireNonNegativeSafeInteger(endTimeMs, "endTimeMs")
    return Math.floor(nowMs / 1000) > Math.floor(endTimeMs / 1000)
}

export function planEventTradeExpiry(
    ownedAmounts: readonly OwnedItemAmount[],
    catalog: ItemInventoryPolicyCatalog,
    nowMs: number,
): EventTradeExpiryPlan {
    requireNonNegativeSafeInteger(nowMs, "nowMs")
    if (!Array.isArray(ownedAmounts)) {
        throw new TypeError("ownedAmounts must be an array")
    }
    const seen = new Set<number>()
    const entries: EventTradeExpiryEntry[] = []
    let totalMana = 0
    for (const owned of ownedAmounts) {
        if (!owned || typeof owned !== "object") {
            throw new TypeError("owned amount entry must be an object")
        }
        const itemId = requireNonNegativeSafeInteger(owned.itemId, "itemId")
        if (itemId <= 0) throw new TypeError("itemId must be positive")
        const amount = requireNonNegativeSafeInteger(owned.amount, `item[${itemId}].amount`)
        if (seen.has(itemId)) throw new TypeError(`duplicate owned Item: ${itemId}`)
        seen.add(itemId)
        if (amount === 0) continue
        const policy = catalog.byItemId[String(itemId)]
        if (!policy || policy.effectKind !== 9 || policy.endTimeMs === null) continue
        if (!isEventTradeExpiredAt(nowMs, policy.endTimeMs)) continue
        const mana = amount * policy.salePrice
        if (!Number.isSafeInteger(mana)) {
            throw new RangeError(`item[${itemId}] expiry Mana must be a safe integer`)
        }
        const nextTotal = totalMana + mana
        if (!Number.isSafeInteger(nextTotal)) {
            throw new RangeError("EventTrade expiry total Mana must be a safe integer")
        }
        totalMana = nextTotal
        entries.push({ itemId, amount, salePrice: policy.salePrice, mana })
    }
    entries.sort((left, right) => left.itemId - right.itemId)
    return deepFreeze({ entries, totalMana })
}
