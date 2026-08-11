import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getPlayerShopCampaignLineupsSync } from "../data/domains/shop-campaign-lineup"
import { getPlayerEquipmentSync, playerOwnsEquipmentSync } from "../data/domains/equipment"
import {
    getBossCoinShopItemsSync,
    getBoxGachaSync,
    getEventShopItemsSync,
    getGenericShopItemsSync,
    getShopSelectItemCampaignsSync,
} from "./assets"
import { buildShopSalesListSync } from "./shop-sales-list"
import { validateBoxGachaPeriod } from "./box-gacha-reset"
import {
    isShopItemVisibleForCampaign,
    requireAvailableShopCampaign,
} from "./shop-select-campaign"
import {
    BossCoinShopItems,
    BoxGachaIdReward,
    BoxGachaRewardType,
    EventShopItems,
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

function mergeShopItems(
    itemsByType: Record<number, ShopItems>,
    shopType: ShopType,
    items: ShopItems | null,
): void {
    if (items === null) return
    itemsByType[shopType] = { ...(itemsByType[shopType] ?? {}), ...items }
}

function getAllAuthoritativeShopItemsSync(): Record<number, ShopItems> {
    const itemsByType: Record<number, ShopItems> = {}
    for (const shopType of [
        ShopType.TREASURE,
        ShopType.GENERAL,
        ShopType.STAR_GRAIN,
        ShopType.TREASURE_EQUIPMENT,
    ]) {
        mergeShopItems(itemsByType, shopType, getGenericShopItemsSync(shopType))
    }

    const repository = getContentSnapshot().repository
    const eventShops = repository.table<EventShopItems>("event_item_shop.json")
    for (const [eventType, events] of Object.entries(eventShops)) {
        for (const eventId of Object.keys(events)) {
            mergeShopItems(
                itemsByType,
                ShopType.EVENT_ITEM,
                getEventShopItemsSync(eventType, eventId),
            )
        }
    }
    const bossCoinShops = repository.table<BossCoinShopItems>("boss_coin_shop.json")
    for (const categoryId of Object.keys(bossCoinShops)) {
        mergeShopItems(
            itemsByType,
            ShopType.BOSS_COIN,
            getBossCoinShopItemsSync(categoryId),
        )
    }
    return itemsByType
}

function shopItemMatchesTarget(item: ShopItem, target: HowToGetTarget): boolean {
    // Only explicit reward rows are authoritative. Costs and display metadata are not sources.
    const expectedType = target.kind === "item"
        ? ShopItemRewardType.ITEM
        : ShopItemRewardType.EQUIPMENT
    return item.rewards.some(reward => (
        reward.type === expectedType
        && (reward as { readonly id?: number }).id === target.id
    ))
}

function getRelevantShopItems(
    itemsByType: Readonly<Record<number, ShopItems>>,
    target: HowToGetTarget,
): { readonly itemsByType: Record<number, ShopItems>, readonly matchingKeys: Set<string> } {
    const relevantItemsByType: Record<number, ShopItems> = {}
    const matchingKeys = new Set<string>()
    for (const [shopTypeText, items] of Object.entries(itemsByType)) {
        const shopType = Number(shopTypeText)
        const matchingEnhancementGroups = new Set<number>()
        for (const [shopItemId, item] of Object.entries(items)) {
            if (shopItemMatchesTarget(item, target)) {
                matchingKeys.add(`${shopType}:${Number(shopItemId)}`)
                if (shopType === ShopType.TREASURE_EQUIPMENT) {
                    matchingEnhancementGroups.add(item.groupId ?? 0)
                }
            }
        }
        const relevantItems = Object.fromEntries(Object.entries(items).filter(([, item]) => (
            shopItemMatchesTarget(item, target)
            || (shopType === ShopType.TREASURE_EQUIPMENT
                && matchingEnhancementGroups.has(item.groupId ?? 0))
        )))
        if (Object.keys(relevantItems).length > 0) relevantItemsByType[shopType] = relevantItems
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
): HowToGetList {
    const relevant = getRelevantShopItems(getAllAuthoritativeShopItemsSync(), target)
    const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
    const campaigns = getShopSelectItemCampaignsSync()
    const dependencies = {
        getEquipmentEnhancementLevel: (ownerId: number, equipmentId: number) => (
            playerOwnsEquipmentSync(ownerId, equipmentId)
                ? (getPlayerEquipmentSync(ownerId, equipmentId)?.enhancementLevel ?? 0)
                : -1
        ),
    }
    const selectedSales = buildShopSalesListSync({
        playerId,
        itemsByType: relevant.itemsByType,
        nowMs,
        isItemVisible: (item, shopType) => (
            isShopItemVisibleForCampaign(item, shopType, campaignLineups)
        ),
    }, dependencies).salesList
    const unselectedSales = buildShopSalesListSync({
        playerId,
        itemsByType: relevant.itemsByType,
        nowMs,
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
