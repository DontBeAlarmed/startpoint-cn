import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getPlayerShopCampaignLineupsSync } from "../data/domains/shop-campaign-lineup"
import { getPlayerEquipmentsByIdsSync } from "../data/domains/equipment"
import { getPlayerShopPurchaseCountsByTypeBulkSync } from "../data/domains/shopPurchase"
import {
    getBoxGachaSync,
} from "./assets"
import { getShopCatalog } from "./shop"
import { buildShopSalesListSync } from "./shop-sales-list"
import { validateBoxGachaPeriod } from "./box-gacha-reset"
import {
    isShopItemVisibleForCampaign,
    requireAvailableShopCampaign,
} from "./shop-select-campaign"
import {
    BoxGachaIdReward,
    BoxGachaRewardType,
    RawBoxRewards,
    ShopItem,
    ShopItemRewardType,
    ShopItems,
    ShopSelectItemCampaigns,
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
): { readonly itemsByType: Record<number, ShopItems>, readonly matchingKeys: Set<string> } {
    const catalog = getShopCatalog()
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
    campaigns: Readonly<ShopSelectItemCampaigns>,
    nowMs: number,
): boolean {
    if (!Number.isSafeInteger(item.campaignId) || item.campaignId! <= 0
        || !Number.isSafeInteger(item.lineupId) || item.lineupId! <= 0) return false
    const selectedLineupId = selections[`${shopType}:${item.campaignId}`]
    if (selectedLineupId !== undefined) return false
    try {
        const campaign = requireAvailableShopCampaign(
            campaigns,
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
    const rewards = getContentSnapshot().repository.table<RawBoxRewards>("box_reward.json")
    const result = new Set<number>()
    for (const [boxGachaId, boxes] of Object.entries(rewards)) {
        const boxGacha = getBoxGachaSync(boxGachaId)
        if (boxGacha === null) continue
        const matches = Object.entries(boxes).some(([boxId, box]) => {
            const settings = boxGacha.boxSettings[Number(boxId)]
            if (settings === undefined) return false
            try {
                validateBoxGachaPeriod(settings, nowMs)
            } catch {
                return false
            }
            return Object.values(box).some(reward => (
                reward.type === expectedType
                && (reward as BoxGachaIdReward).id === target.id
            ))
        })
        if (matches) result.add(Number(boxGachaId))
    }
    return [...result].sort((a, b) => a - b)
}

export function getHowToGetListSync(
    playerId: number,
    target: HowToGetTarget,
    nowMs: number,
    purchasePeriodNowMs = nowMs,
    resetHour = 5,
): HowToGetList {
    const relevant = getRelevantShopItemsFromCatalog(target)
    const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
    const campaigns = getContentSnapshot().repository.table<ShopSelectItemCampaigns>(
        "shop_select_item_campaign.json",
    )
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
            campaigns,
            nowMs,
        ),
    }, dependencies).salesList

    return {
        box_gacha_id_list: getMatchingBoxGachaIds(target, nowMs),
        shop_sales_list: filterMatchingSales(selectedSales, relevant.matchingKeys),
        unselected_lineup_shop_sales_list: filterMatchingSales(unselectedSales, relevant.matchingKeys),
    }
}
