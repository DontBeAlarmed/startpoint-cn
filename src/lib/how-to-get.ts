import { getPlayerShopCampaignLineupsSync } from "../data/domains/shop-campaign-lineup"
import { getPlayerEquipmentsByIdsSync } from "../data/domains/equipment"
import { getPlayerShopPurchaseCountsByTypeBulkSync } from "../data/domains/shopPurchase"
import {
    findAvailableBoxGachaIdsForReward,
    getBoxGachaContentCatalog,
} from "./box-gacha-content"
import { getShopCatalog, type ShopCatalog } from "./shop"
import { buildShopSalesListSync } from "./shop-sales-list"
import {
    isShopItemVisibleForCampaign,
    requireAvailableShopCampaign,
} from "./shop-select-campaign"
import {
    BoxGachaRewardType,
    ShopItem,
    ShopItemRewardType,
    ShopItems,
    ShopType,
} from "./types"

export type HowToGetTarget =
    | { readonly kind: "item", readonly id: number }
    | { readonly kind: "equipment", readonly id: number }

export interface HowToGetList {
    readonly box_gacha_id_list: number[]
    readonly shop_sales_list: Object[]
    readonly unselected_lineup_shop_sales_list: Object[]
}

interface SalesListItemIdentity {
    readonly shop_item_id: number
    readonly shop_type: number
}

function getRelevantShopItemsFromCatalog(
    target: HowToGetTarget,
    catalog: ShopCatalog,
): { readonly itemsByType: Record<number, ShopItems>, readonly matchingKeys: Set<string> } {
    const expectedType = target.kind === "item"
        ? ShopItemRewardType.ITEM
        : ShopItemRewardType.EQUIPMENT
    const matchedKeys = catalog.rewardProductKeys[`${expectedType}:${target.id}`] ?? []
    const relevantItemsByType: Record<number, ShopItems> = {}
    const matchingKeys = new Set(matchedKeys)
    const includeKeys = new Set(matchedKeys)
    for (const key of matchedKeys) {
        const entry = catalog.entries[key]
        if (entry?.kind !== "purchase") continue
        if (entry.scope.kind !== "equipmentEnhancement") continue
        const groupKey = `${entry.scope.categoryId}:${entry.scope.groupId}:${entry.scope.equipmentId}`
        for (const stageId of catalog.equipmentGroupProductIds[groupKey] ?? []) {
            includeKeys.add(`${ShopType.TREASURE_EQUIPMENT}:${stageId}`)
        }
    }
    for (const key of includeKeys) {
        const entry = catalog.entries[key]
        if (entry?.kind !== "purchase") continue
        const items = relevantItemsByType[entry.shopType] ??= {}
        items[String(entry.shopItemId)] = entry.item
    }
    return { itemsByType: relevantItemsByType, matchingKeys }
}

function filterMatchingSales(sales: Object[], matchingKeys: ReadonlySet<string>): Object[] {
    return sales.filter(value => {
        const item = value as SalesListItemIdentity
        return matchingKeys.has(`${item.shop_type}:${item.shop_item_id}`)
    }).sort((a, b) => {
        const left = a as SalesListItemIdentity
        const right = b as SalesListItemIdentity
        return left.shop_type - right.shop_type || left.shop_item_id - right.shop_item_id
    })
}

function isUnselectedLineupItemAvailable(
    item: Pick<ShopItem, "campaignId" | "lineupId">,
    shopType: number,
    selections: Readonly<Record<string, number>>,
    catalog: Pick<ShopCatalog, "campaignsByKey">,
    nowMs: number,
): boolean {
    if (!Number.isSafeInteger(item.campaignId) || item.campaignId! <= 0
        || !Number.isSafeInteger(item.lineupId) || item.lineupId! <= 0) return false
    const selectedLineupId = selections[`${shopType}:${item.campaignId}`]
    if (selectedLineupId !== undefined) return false
    try {
        const campaign = requireAvailableShopCampaign(
            catalog,
            shopType,
            item.campaignId!,
            null,
            nowMs,
        )
        return campaign.lineupIds.includes(item.lineupId!)
    } catch {
        return false
    }
}

function getMatchingBoxGachaIds(target: HowToGetTarget, nowMs: number): number[] {
    const expectedType = target.kind === "item"
        ? BoxGachaRewardType.ITEM
        : BoxGachaRewardType.EQUIPMENT
    return [...findAvailableBoxGachaIdsForReward(
        getBoxGachaContentCatalog(),
        expectedType,
        target.id,
        nowMs,
    )]
}

export function getHowToGetListSync(
    playerId: number,
    target: HowToGetTarget,
    nowMs: number,
    purchasePeriodNowMs = nowMs,
    resetHour = 5,
): HowToGetList {
    const catalog = getShopCatalog()
    const relevant = getRelevantShopItemsFromCatalog(target, catalog)
    const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
    const equipmentIds = Object.values(relevant.itemsByType[ShopType.TREASURE_EQUIPMENT] ?? {})
        .map(item => item.equipmentId)
        .filter((equipmentId): equipmentId is number => equipmentId !== undefined)
    const equipment = getPlayerEquipmentsByIdsSync(playerId, equipmentIds)
    const dependencies = {
        getPurchaseCountsBulk: getPlayerShopPurchaseCountsByTypeBulkSync,
        getEquipmentEnhancementLevel: (_ownerId: number, equipmentId: number) => (
            equipment[String(equipmentId)]?.enhancementLevel ?? -1
        ),
    }
    const selectedSales = buildShopSalesListSync({
        playerId,
        itemsByType: relevant.itemsByType,
        nowMs,
        purchasePeriodNowMs,
        resetHour,
        isItemVisible: (item, shopType) => (
            isShopItemVisibleForCampaign(item, shopType, campaignLineups)
        ),
    }, dependencies).salesList
    const unselectedSales = buildShopSalesListSync({
        playerId,
        itemsByType: relevant.itemsByType,
        nowMs,
        purchasePeriodNowMs,
        resetHour,
        isItemVisible: (item, shopType) => isUnselectedLineupItemAvailable(
            item,
            shopType,
            campaignLineups,
            catalog,
            nowMs,
        ),
    }, dependencies).salesList

    return {
        box_gacha_id_list: getMatchingBoxGachaIds(target, nowMs),
        shop_sales_list: filterMatchingSales(selectedSales, relevant.matchingKeys),
        unselected_lineup_shop_sales_list: filterMatchingSales(unselectedSales, relevant.matchingKeys),
    }
}
