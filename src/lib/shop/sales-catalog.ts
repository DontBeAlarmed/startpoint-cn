import { ShopType, type ShopItem, type ShopItems } from "../types/shop"
import type { ShopCatalog } from "./model"
import {
    resolveRushFinalOperationEventView,
    type RushFinalOperationOverride,
} from "./rush-final-operation-override"

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
    transformItem: ((item: ShopItem) => ShopItem) | null = null,
): void {
    for (const key of keys) {
        const entry = catalog.entries[key]
        if (entry === undefined || !entry.listed) continue
        const items = result[entry.shopType] ??= {}
        items[String(entry.shopItemId)] = entry.kind === "purchase"
            ? (transformItem === null ? entry.item : transformItem(entry.item))
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
    rushOverride: RushFinalOperationOverride | null = null,
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
            const view = resolveRushFinalOperationEventView(
                catalog,
                rushOverride,
                event.eventType,
                eventId,
                catalog.eventProductIds[`${event.eventType}:${eventId}`] ?? [],
            )
            appendProducts(
                result,
                catalog,
                view.productIds.map(shopItemId => `${ShopType.EVENT_ITEM}:${shopItemId}`),
                view.itemTransform,
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
