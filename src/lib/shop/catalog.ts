import { deepFreeze } from "../../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import type {
    BossCoinShopItems,
    EventShopItems,
    ShopCostItemScheduleRows,
    ShopItem,
    ShopItemCampaignMap,
    ShopItems,
} from "../types/shop"
import { ShopType } from "../types/shop"
import type {
    ShopCatalog,
    ShopCatalogEntry,
    ShopCatalogScope,
    ShopNavigationProduct,
    ShopPurchaseProduct,
} from "./model"
import { shopCatalogKey } from "./model"
import {
    addRushCompatibilityPeriod,
    RUSH_COMPATIBILITY_EVENTS,
} from "./rush-compatibility"

const GENERIC_TABLES: readonly (readonly [ShopType, string])[] = [
    [ShopType.TREASURE, "treasure_shop.json"],
    [ShopType.SPECIAL_PACK, "special_pack_shop.json"],
    [ShopType.MANA, "mana_shop.json"],
    [ShopType.GENERAL, "general_shop.json"],
    [ShopType.STAR_GRAIN, "star_grain_shop.json"],
    [ShopType.TREASURE_EQUIPMENT, "equipment_enhancement_shop.json"],
]

interface MutableCatalog {
    entries: Record<string, ShopCatalogEntry>
    productIdsByType: Record<string, number[]>
    eventProductIds: Record<string, number[]>
    bossProductIds: Record<string, number[]>
    equipmentGroupProductIds: Record<string, number[]>
    rewardProductKeys: Record<string, string[]>
    scheduleRowsByMonth: Record<string, ShopCostItemScheduleRows[string]>
}

function append(index: Record<string, number[]>, key: string, value: number): void {
    (index[key] ??= []).push(value)
}

function cloneItem(item: ShopItem): ShopItem {
    return {
        ...item,
        costs: item.costs.map(cost => ({ ...cost })),
        rewards: item.rewards.map(reward => ({ ...reward })),
        compatibilityPeriods: item.compatibilityPeriods?.map(period => ({ ...period })),
        specifiedMonths: item.specifiedMonths === undefined
            ? undefined
            : [...item.specifiedMonths],
    }
}

function campaignScope(
    scope: ShopCatalogScope,
    item: ShopItem,
    reference: { campaignId: number; lineupId?: number } | undefined,
): { scope: ShopCatalogScope; item: ShopItem } {
    if (scope.kind !== "event" && scope.kind !== "bossCoin") return { scope, item }
    const campaignId = item.campaignId ?? reference?.campaignId
    const lineupId = item.lineupId ?? reference?.lineupId
    const nextItem = campaignId === undefined
        ? item
        : { ...item, campaignId, ...(lineupId === undefined ? {} : { lineupId }) }
    return {
        item: nextItem,
        scope: {
            ...scope,
            ...(campaignId === undefined ? {} : { campaignId }),
            ...(lineupId === undefined ? {} : { lineupId }),
        },
    }
}

function addEntry(
    catalog: MutableCatalog,
    shopType: ShopType,
    shopItemIdText: string,
    sourceItem: ShopItem,
    scope: ShopCatalogScope,
    listed: boolean,
    reference?: { campaignId: number; lineupId?: number },
): void {
    const shopItemId = Number(shopItemIdText)
    if (!Number.isSafeInteger(shopItemId)) {
        throw new TypeError(`Invalid shop item id: ${shopItemIdText}`)
    }
    const key = shopCatalogKey(shopType, shopItemId)
    if (catalog.entries[key] !== undefined) {
        throw new Error(`Duplicate shop catalog entry: ${key}`)
    }
    const item = cloneItem(sourceItem)
    const periods = [{
        availableFrom: item.availableFrom,
        availableUntil: item.availableUntil,
    }, ...(item.compatibilityPeriods ?? [])]
    if (item.purchaseKind === "specialExchangeLink") {
        if (shopType !== ShopType.SPECIAL_PACK
            || !Number.isSafeInteger(item.specialExchangeCampaignId)
            || item.specialExchangeCampaignId! <= 0) {
            throw new TypeError(`Invalid special exchange link: ${key}`)
        }
        const entry: ShopNavigationProduct = {
            kind: "specialExchangeLink",
            shopType: ShopType.SPECIAL_PACK,
            shopItemId,
            periods,
            listed,
            specialExchangeCampaignId: item.specialExchangeCampaignId!,
        }
        catalog.entries[key] = entry
        append(catalog.productIdsByType, String(shopType), shopItemId)
        return
    }
    if (item.purchaseKind !== undefined && item.purchaseKind !== "purchase") {
        throw new TypeError(`Invalid shop purchase kind: ${key}`)
    }
    const scoped = campaignScope(scope, item, reference)
    const entry: ShopPurchaseProduct = {
        kind: "purchase",
        shopType,
        shopItemId,
        item: scoped.item,
        periods,
        listed,
        scope: scoped.scope,
    }
    catalog.entries[key] = entry
    append(catalog.productIdsByType, String(shopType), shopItemId)
    for (const reward of scoped.item.rewards) {
        if (!("id" in reward) || !Number.isSafeInteger(reward.id)) continue
        const rewardKey = `${reward.type}:${reward.id}`
        ;(catalog.rewardProductKeys[rewardKey] ??= []).push(key)
    }
}

function rushCompatibilityForSource(
    eventShops: EventShopItems,
    eventType: number,
    eventId: number,
) {
    if (eventType !== 11) return null
    for (const [targetEventId, compatibility] of Object.entries(RUSH_COMPATIBILITY_EVENTS)) {
        if (compatibility.sourceEventId !== eventId) continue
        const targetItems = eventShops["11"]?.[targetEventId]
        return targetItems !== undefined && Object.keys(targetItems).length > 0
            ? null
            : compatibility
    }
    return null
}

function buildScheduleIndex(
    schedules: ShopCostItemScheduleRows,
): MutableCatalog["scheduleRowsByMonth"] {
    const result: MutableCatalog["scheduleRowsByMonth"] = {}
    for (const [scheduleId, rows] of Object.entries(schedules)) {
        for (const row of rows) {
            (result[`${scheduleId}:${row.month}`] ??= []).push({
                ...row,
                costs: row.costs.map(cost => ({ ...cost })),
            })
        }
    }
    return result
}

export function buildShopCatalog(repository: ReadonlyContentRepository): ShopCatalog {
    const campaignMap = repository.table<ShopItemCampaignMap>("shop_item_campaign.json")
    const generalWhitelist = new Set(
        repository.table<readonly number[]>("cdn_general_shop_whitelist.json"),
    )
    const catalog: MutableCatalog = {
        entries: {},
        productIdsByType: {},
        eventProductIds: {},
        bossProductIds: {},
        equipmentGroupProductIds: {},
        rewardProductKeys: {},
        scheduleRowsByMonth: buildScheduleIndex(
            repository.table<ShopCostItemScheduleRows>("shop_cost_item_schedule.json"),
        ),
    }

    for (const [shopType, tableName] of GENERIC_TABLES) {
        for (const [itemId, item] of Object.entries(repository.table<ShopItems>(tableName))) {
            const equipmentScope: ShopCatalogScope = shopType === ShopType.TREASURE_EQUIPMENT
                ? {
                    kind: "equipmentEnhancement",
                    categoryId: item.shopCategoryId ?? 0,
                    groupId: item.groupId ?? 0,
                    equipmentId: item.equipmentId ?? 0,
                }
                : { kind: "ordinary" }
            addEntry(
                catalog,
                shopType,
                itemId,
                item,
                equipmentScope,
                shopType !== ShopType.GENERAL || generalWhitelist.has(Number(itemId)),
            )
            if (shopType === ShopType.TREASURE_EQUIPMENT) {
                append(
                    catalog.equipmentGroupProductIds,
                    `${item.shopCategoryId ?? 0}:${item.groupId ?? 0}:${item.equipmentId ?? 0}`,
                    Number(itemId),
                )
            }
        }
    }

    const eventShops = repository.table<EventShopItems>("event_item_shop.json")
    for (const [eventTypeText, events] of Object.entries(eventShops)) {
        const eventType = Number(eventTypeText)
        for (const [eventIdText, items] of Object.entries(events)) {
            const eventId = Number(eventIdText)
            const compatibility = rushCompatibilityForSource(eventShops, eventType, eventId)
            for (const [itemId, item] of Object.entries(items)) {
                const effectiveItem = compatibility === null
                    ? item
                    : addRushCompatibilityPeriod(item, compatibility)
                addEntry(
                    catalog,
                    ShopType.EVENT_ITEM,
                    itemId,
                    effectiveItem,
                    { kind: "event", eventType, eventId },
                    true,
                    campaignMap[String(ShopType.EVENT_ITEM)]?.[itemId],
                )
                append(catalog.eventProductIds, `${eventType}:${eventId}`, Number(itemId))
            }
        }
    }
    for (const [targetEventId, compatibility] of Object.entries(RUSH_COMPATIBILITY_EVENTS)) {
        const targetKey = `11:${targetEventId}`
        if ((catalog.eventProductIds[targetKey]?.length ?? 0) > 0) continue
        const sourceItems = eventShops["11"]?.[String(compatibility.sourceEventId)]
        if (sourceItems === undefined || Object.keys(sourceItems).length === 0) continue
        catalog.eventProductIds[targetKey] = Object.keys(sourceItems).map(Number)
    }

    const bossShops = repository.table<BossCoinShopItems>("boss_coin_shop.json")
    for (const [categoryIdText, items] of Object.entries(bossShops)) {
        const categoryId = Number(categoryIdText)
        for (const [itemId, item] of Object.entries(items)) {
            addEntry(
                catalog,
                ShopType.BOSS_COIN,
                itemId,
                item,
                { kind: "bossCoin", categoryId },
                true,
                campaignMap[String(ShopType.BOSS_COIN)]?.[itemId],
            )
            append(catalog.bossProductIds, categoryIdText, Number(itemId))
        }
    }

    for (const ids of Object.values(catalog.equipmentGroupProductIds)) {
        ids.sort((left, right) => {
            const leftEntry = catalog.entries[shopCatalogKey(ShopType.TREASURE_EQUIPMENT, left)]
            const rightEntry = catalog.entries[shopCatalogKey(ShopType.TREASURE_EQUIPMENT, right)]
            const leftStage = leftEntry?.kind === "purchase" ? leftEntry.item.stage ?? 0 : 0
            const rightStage = rightEntry?.kind === "purchase" ? rightEntry.item.stage ?? 0 : 0
            return leftStage - rightStage || left - right
        })
    }
    return deepFreeze(catalog)
}

const catalogs = new WeakMap<ReadonlyContentRepository, ShopCatalog>()

export function getShopCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): ShopCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildShopCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}
