import { deepFreeze } from "../../content/deep-freeze"
import type { ShopItem } from "../types/shop"
import type { EffectiveShopOffer, ShopCatalog } from "./model"
import { shopCatalogKey } from "./model"
import {
    getShopCnMonth,
    isShopPeriodAvailable,
} from "./period"

export class ShopOfferNotPurchasableError extends Error {}
export class ShopOfferPeriodError extends Error {}
export class ShopOfferScheduleError extends Error {}

export function resolveEffectiveShopOffer(
    catalog: ShopCatalog,
    shopType: number,
    shopItemId: number,
    nowMs: number,
): EffectiveShopOffer {
    if (!Number.isFinite(nowMs)) throw new ShopOfferPeriodError("Invalid shop time.")
    const entry = catalog.entries[shopCatalogKey(shopType, shopItemId)]
    if (entry === undefined || entry.kind !== "purchase") {
        throw new ShopOfferNotPurchasableError("Shop offer is not purchasable.")
    }
    if (!entry.periods.some(period => isShopPeriodAvailable(period, nowMs))) {
        throw new ShopOfferPeriodError("Shop offer is outside its available period.")
    }

    const month = getShopCnMonth(nowMs)
    let item: Readonly<ShopItem> = entry.item
    if (entry.item.costScheduleId !== undefined) {
        const rows = catalog.scheduleRowsByMonth[`${entry.item.costScheduleId}:${month}`] ?? []
        const effectiveRows = rows.filter(row => isShopPeriodAvailable(row, nowMs))
        if (effectiveRows.length !== 1) {
            throw new ShopOfferScheduleError("Shop cost schedule is missing or ambiguous.")
        }
        item = deepFreeze({
            ...entry.item,
            costs: effectiveRows[0].costs.map(cost => ({ ...cost })),
        })
    }
    return deepFreeze({
        ...entry,
        item,
        virtualMonthCn: month,
    })
}
