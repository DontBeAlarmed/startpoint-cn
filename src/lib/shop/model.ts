import type {
    ShopCostItemScheduleRow,
    ShopItem,
    ShopItemAvailabilityPeriod,
    ShopType,
} from "../types/shop"

export type ShopCatalogScope =
    | { readonly kind: "ordinary" }
    | {
        readonly kind: "event"
        readonly eventType: number
        readonly eventId: number
        readonly campaignId?: number
        readonly lineupId?: number
    }
    | {
        readonly kind: "bossCoin"
        readonly categoryId: number
        readonly campaignId?: number
        readonly lineupId?: number
    }
    | {
        readonly kind: "equipmentEnhancement"
        readonly categoryId: number
        readonly groupId: number
        readonly equipmentId: number
    }

interface ShopCatalogEntryBase {
    readonly shopType: ShopType
    readonly shopItemId: number
    readonly periods: readonly Readonly<ShopItemAvailabilityPeriod>[]
    readonly listed: boolean
}

export interface ShopPurchaseProduct extends ShopCatalogEntryBase {
    readonly kind: "purchase"
    readonly item: Readonly<ShopItem>
    readonly scope: ShopCatalogScope
}

export interface ShopNavigationProduct extends ShopCatalogEntryBase {
    readonly kind: "specialExchangeLink"
    readonly shopType: ShopType.SPECIAL_PACK
    readonly specialExchangeCampaignId: number
    readonly listing: Readonly<Pick<ShopItem,
        | "stock"
        | "dailyStock"
        | "monthlyStock"
        | "maxFrequency"
        | "specifiedMonths"
    >>
}

export type ShopCatalogEntry = ShopPurchaseProduct | ShopNavigationProduct

export interface ShopCatalog {
    readonly entries: Readonly<Record<string, ShopCatalogEntry>>
    readonly productIdsByType: Readonly<Record<string, readonly number[]>>
    readonly eventProductIds: Readonly<Record<string, readonly number[]>>
    readonly bossProductIds: Readonly<Record<string, readonly number[]>>
    readonly equipmentGroupProductIds: Readonly<Record<string, readonly number[]>>
    readonly rewardProductKeys: Readonly<Record<string, readonly string[]>>
    readonly scheduleRowsByMonth: Readonly<Record<string, readonly Readonly<ShopCostItemScheduleRow>[]>>
}

export interface EffectiveShopOffer extends Omit<ShopPurchaseProduct, "item"> {
    readonly item: Readonly<ShopItem>
    readonly virtualMonthCn: number
}

export function shopCatalogKey(shopType: number, shopItemId: number): string {
    return `${shopType}:${shopItemId}`
}
