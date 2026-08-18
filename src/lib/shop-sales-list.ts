import CDN_GENERAL_SHOP_WHITELIST from "../../assets/cdn_general_shop_whitelist.json"
import {
    getPlayerShopPurchaseCountsByTypeBulkSync,
    getPlayerShopPurchaseCountsByTypeSync,
    getShopPurchaseQueryKey,
    ShopPurchaseQuery,
} from "../data/domains/shopPurchase"
import {
    calculateShopStockQuantity,
    getShopPurchasePeriodKeys,
    isShopItemAvailable,
} from "./event-shop-purchase"
import { ShopItem, ShopItems, ShopType } from "./types"

const GENERAL_SHOP_CDN_KEYS: Set<number> = new Set(CDN_GENERAL_SHOP_WHITELIST)

export interface ShopSalesListDependencies {
    getPurchaseCounts?: typeof getPlayerShopPurchaseCountsByTypeSync
    getPurchaseCountsBulk?: typeof getPlayerShopPurchaseCountsByTypeBulkSync
    getEquipmentEnhancementLevel?: (playerId: number, equipmentId: number) => number
}

export interface BuildShopSalesListInput {
    playerId: number
    itemsByType: Readonly<Record<number, ShopItems>>
    nowMs: number
    equipmentEnhancementCategoryIds?: readonly number[]
    isItemVisible: (item: Pick<ShopItem, "campaignId" | "lineupId">, shopType: number) => boolean
}

export interface ShopSalesListBuildResult {
    salesList: Object[]
    filteredGeneralCount: number
}

function buildEnhancementSalesList(
    playerId: number,
    items: ShopItems,
    getEquipmentEnhancementLevel: (playerId: number, equipmentId: number) => number,
): Object[] {
    if (Object.keys(items).length === 0) return []

    const groups = new Map<number, { items: { id: string, item: ShopItem, stage: number }[], equipmentId: number }>()
    for (const [itemId, item] of Object.entries(items)) {
        const groupId = item.groupId ?? 0
        const group = groups.get(groupId) ?? {
            items: [],
            equipmentId: item.equipmentId ?? 0,
        }
        group.items.push({ id: itemId, item, stage: item.stage ?? 0 })
        groups.set(groupId, group)
    }

    const result: Object[] = []
    for (const group of groups.values()) {
        group.items.sort((a, b) => a.stage - b.stage)
        const enhancementLevel = getEquipmentEnhancementLevel(playerId, group.equipmentId)
        let targetItem: { id: string, item: ShopItem } = group.items[0]
        let stockQuantity = targetItem.item.enhancementMaxLevel ?? 0
        let totalPurchaseNum = 0

        if (enhancementLevel >= 0) {
            const nextItem = group.items.find(entry => (
                (entry.item.enhancementMaxLevel ?? 0) > enhancementLevel
            ))
            targetItem = nextItem ?? group.items[group.items.length - 1]
            stockQuantity = nextItem === undefined
                ? 0
                : (nextItem.item.enhancementMaxLevel ?? 0) - enhancementLevel
            totalPurchaseNum = enhancementLevel
        }

        const maxLevel = group.items[group.items.length - 1].item.enhancementMaxLevel ?? 0
        result.push({
            shop_item_id: Number(targetItem.id),
            stock_quantity: stockQuantity,
            today_purchase_num: 0,
            this_month_purchase_num: null,
            total_purchase_num: totalPurchaseNum,
            discount_id: null,
            discount_rate: null,
            discounted_price: null,
            group_info: {
                group_total_stock_quantity: maxLevel - totalPurchaseNum,
                group_total_purchase_num: totalPurchaseNum,
                multi_stage: group.items.length > 1,
            },
            shop_type: ShopType.TREASURE_EQUIPMENT,
        })
    }
    return result
}

export function buildShopSalesListSync(
    input: BuildShopSalesListInput,
    dependencies: ShopSalesListDependencies = {},
): ShopSalesListBuildResult {
    const getPurchaseCounts = dependencies.getPurchaseCounts ?? getPlayerShopPurchaseCountsByTypeSync
    const getPurchaseCountsBulk = dependencies.getPurchaseCountsBulk
    const getEquipmentEnhancementLevel = dependencies.getEquipmentEnhancementLevel ?? (() => -1)
    const salesList: Object[] = []
    let filteredGeneralCount = 0
    const enhancementItems: ShopItems = {}
    const pendingSales: Array<{
        itemId: number
        item: ShopItem
        shopType: number
        query: ShopPurchaseQuery
    }> = []

    for (const [shopTypeText, items] of Object.entries(input.itemsByType)) {
        const shopType = Number(shopTypeText)
        for (const [itemId, item] of Object.entries(items)) {
            if (shopType === ShopType.GENERAL && !GENERAL_SHOP_CDN_KEYS.has(Number(itemId))) {
                filteredGeneralCount++
                continue
            }
            if (shopType === ShopType.TREASURE_EQUIPMENT
                && input.equipmentEnhancementCategoryIds?.length
                && (item.shopCategoryId === undefined
                    || !input.equipmentEnhancementCategoryIds.includes(item.shopCategoryId))) {
                continue
            }
            if (!isShopItemAvailable(item, input.nowMs)) continue
            if (!input.isItemVisible(item, shopType)) continue

            if (shopType === ShopType.TREASURE_EQUIPMENT) {
                enhancementItems[itemId] = item
                continue
            }

            const periodKeys = getShopPurchasePeriodKeys(input.nowMs, item.specifiedMonths)
            pendingSales.push({
                itemId: Number(itemId),
                item,
                shopType,
                query: { shopType, shopItemId: Number(itemId), keys: periodKeys },
            })
        }
    }

    const appendSale = ({ itemId, item, shopType, query }: typeof pendingSales[number], counts: ReturnType<typeof getPurchaseCounts>) => {
            const stockQuantity = calculateShopStockQuantity(item, counts)
            salesList.push({
                shop_item_id: itemId,
                stock_quantity: stockQuantity,
                today_purchase_num: item.dailyStock === undefined ? 0 : counts.daily,
                this_month_purchase_num: item.monthlyStock === undefined ? null : counts.monthly,
                total_purchase_num: counts.total,
                group_info: {
                    group_total_stock_quantity: stockQuantity,
                    group_total_purchase_num: counts.total,
                    multi_stage: false,
                },
                shop_type: shopType,
            })
    }

    if (getPurchaseCountsBulk !== undefined) {
        const countsByKey = getPurchaseCountsBulk(
            input.playerId,
            pendingSales.map(sale => sale.query),
        )
        for (const sale of pendingSales) {
            const counts = countsByKey.get(getShopPurchaseQueryKey(sale.query))
            if (counts === undefined) {
                throw new Error(`Missing bulk purchase counts for shop item ${sale.itemId}.`)
            }
            appendSale(sale, counts)
        }
    } else {
        for (const sale of pendingSales) {
            appendSale(
                sale,
                getPurchaseCounts(
                    input.playerId,
                    sale.shopType,
                    sale.itemId,
                    sale.query.keys,
                ),
            )
        }
    }

    salesList.push(...buildEnhancementSalesList(
        input.playerId,
        enhancementItems,
        getEquipmentEnhancementLevel,
    ))
    return { salesList, filteredGeneralCount }
}
