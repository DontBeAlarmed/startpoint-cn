import type { ShopItem } from "../types/shop"
import type { ShopPurchaseCountSnapshot } from "./purchase-plan"

export function calculateShopStockQuantity(
    shopItem: ShopItem,
    counts: ShopPurchaseCountSnapshot,
): number {
    const remaining: number[] = []
    if (shopItem.dailyStock !== undefined) remaining.push(shopItem.dailyStock - counts.daily)
    if (shopItem.monthlyStock !== undefined) remaining.push(shopItem.monthlyStock - counts.monthly)
    if (shopItem.maxFrequency !== undefined) remaining.push(shopItem.maxFrequency - counts.total)
    return remaining.length === 0 ? -1 : Math.max(0, Math.min(...remaining))
}
