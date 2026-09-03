import { ShopType, type ShopItems } from "../types/shop"
import type { ShopCatalog } from "./model"

export interface ShopSalesCatalogRequest {
    readonly shopTypes: readonly ShopType[]
    readonly eventList: readonly {
        readonly eventType: number
        readonly eventIds: readonly number[]
    }[]
    readonly bossCategoryIds: readonly number[]
}

function appendProducts(
    result: Record<number, ShopItems>,
    catalog: ShopCatalog,
    keys: readonly string[],
): void {
    for (const key of keys) {
        const entry = catalog.entries[key]
        if (entry === undefined || !entry.listed) continue
        const items = result[entry.shopType] ??= {}
        items[String(entry.shopItemId)] = entry.kind === "purchase"
            ? entry.item
            : {
                costs: [],
                rewards: [],
                availableFrom: entry.periods[0].availableFrom,
                availableUntil: entry.periods[0].availableUntil,
                ...entry.listing,
            }
    }
}

export function selectShopSalesCatalogItems(
    catalog: ShopCatalog,
    request: ShopSalesCatalogRequest,
): Record<number, ShopItems> {
    const result: Record<number, ShopItems> = {}
    for (const shopType of request.shopTypes) {
        if (shopType === ShopType.EVENT_ITEM || shopType === ShopType.BOSS_COIN) continue
        appendProducts(
            result,
            catalog,
            (catalog.productIdsByType[String(shopType)] ?? [])
                .map(shopItemId => `${shopType}:${shopItemId}`),
        )
    }
    for (const event of request.eventList) {
        for (const eventId of event.eventIds) {
            appendProducts(
                result,
                catalog,
                (catalog.eventProductIds[`${event.eventType}:${eventId}`] ?? [])
                    .map(shopItemId => `${ShopType.EVENT_ITEM}:${shopItemId}`),
            )
        }
    }
    for (const categoryId of request.bossCategoryIds) {
        appendProducts(
            result,
            catalog,
            (catalog.bossProductIds[String(categoryId)] ?? [])
                .map(shopItemId => `${ShopType.BOSS_COIN}:${shopItemId}`),
        )
    }
    return result
}
