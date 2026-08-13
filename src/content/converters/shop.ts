import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import type {
    BossCoinShopItems,
    EventShopItems,
    ShopItem,
    ShopItemCampaignMap,
    ShopItems,
    ShopSelectItemCampaigns,
} from "../../lib/types/shop"
import { ShopItemUserCostType } from "../../lib/types/shop"
import { parseCsvLine } from "./csv"

const GENERAL_SHOP_PATH = "master/shop/general_shop.orderedmap"
const EVENT_ITEM_SHOP_PATH = "master/shop/event_item_shop.orderedmap"
const EVENT_SELECT_CAMPAIGN_PATH =
    "master/quest/event/event_shop_select_item_campaign.orderedmap"
const EVENT_SELECT_LINEUP_PATH =
    "master/quest/event/event_shop_select_item_campaign_lineup.orderedmap"
const BOSS_COIN_SHOP_PATH = "master/shop/boss_coin_shop.orderedmap"
const BOSS_COIN_SHOP_CATEGORY_PATH = "master/shop/boss_coin_shop_category.orderedmap"
const BOSS_SELECT_CAMPAIGN_PATH =
    "master/shop/boss_coin_shop_select_item_campaign.orderedmap"
const BOSS_SELECT_LINEUP_PATH =
    "master/shop/boss_coin_shop_select_item_campaign_lineup.orderedmap"
const STAR_GRAIN_SHOP_PATH = "master/shop/star_grain_shop.orderedmap"
const TREASURE_SHOP_PATH = "master/shop/treasure_shop.orderedmap"
const EQUIPMENT_ENHANCEMENT_SHOP_PATH =
    "master/equipment_enhancement/equipment_enhancement_shop.orderedmap"
const EQUIPMENT_ENHANCEMENT_SHOP_CATEGORY_PATH =
    "master/equipment_enhancement/equipment_enhancement_shop_category.orderedmap"
const SPECIAL_PACK_SHOP_PATH = "master/shop/special_pack_shop.orderedmap"

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
        ? readonly DeepReadonly<U>[]
        : T extends object
            ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T

export interface ShopSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface ShopConversionOutput {
    readonly "general_shop.json": DeepReadonly<ShopItems>
    readonly "event_item_shop.json": DeepReadonly<EventShopItems>
    readonly "event_item_shop_id_map.json": Readonly<
        Record<string, { readonly eventType: number; readonly eventId: number }>
    >
    readonly "boss_coin_shop.json": DeepReadonly<BossCoinShopItems>
    readonly "boss_coin_shop_item_category_map.json": Readonly<Record<string, number>>
    readonly "shop_select_item_campaign.json": DeepReadonly<ShopSelectItemCampaigns>
    readonly "shop_item_campaign.json": DeepReadonly<ShopItemCampaignMap>
    readonly "star_grain_shop.json": DeepReadonly<ShopItems>
    readonly "treasure_shop.json": DeepReadonly<ShopItems>
    readonly "equipment_enhancement_shop.json": DeepReadonly<ShopItems>
    readonly "special_pack_shop.json": DeepReadonly<ShopItems>
}

interface ShopLayout {
    readonly tableName: string
    readonly columnCount: number
    readonly priceStart?: number
    readonly costStarts: readonly number[]
    readonly availableFrom: number
    readonly availableUntil: number
    readonly stock: {
        readonly column: number
        readonly emptyValue?: number
    }
    readonly maxFrequency?: number
    readonly dailyStock?: number
    readonly specifiedMonths?: number
    readonly monthlyStock?: number
    readonly rewardStarts: readonly number[]
}

type ParsedRow = readonly [string, string[]]

const GENERAL_LAYOUT: ShopLayout = {
    tableName: "general_shop",
    columnCount: 47,
    priceStart: 9,
    costStarts: [12, 14, 16, 18],
    availableFrom: 20,
    availableUntil: 21,
    stock: { column: 23 },
    maxFrequency: 24,
    dailyStock: 25,
    specifiedMonths: 26,
    monthlyStock: 27,
    rewardStarts: [29, 32, 35, 38, 41, 44],
}

const EVENT_LAYOUT: ShopLayout = {
    tableName: "event_item_shop",
    columnCount: 51,
    priceStart: 15,
    costStarts: [18, 20, 22, 24],
    availableFrom: 26,
    availableUntil: 27,
    stock: { column: 29 },
    maxFrequency: 30,
    dailyStock: 31,
    rewardStarts: [32, 35, 38, 41, 44, 47],
}

const BOSS_LAYOUT: ShopLayout = {
    tableName: "boss_coin_shop",
    columnCount: 50,
    priceStart: 14,
    costStarts: [17, 19, 21, 23],
    availableFrom: 25,
    availableUntil: 26,
    stock: { column: 28 },
    maxFrequency: 29,
    dailyStock: 30,
    monthlyStock: 31,
    rewardStarts: [32, 35, 38, 41, 44, 47],
}

const STAR_GRAIN_LAYOUT: ShopLayout = {
    tableName: "star_grain_shop",
    columnCount: 43,
    priceStart: 7,
    costStarts: [10, 12, 14, 16],
    availableFrom: 18,
    availableUntil: 19,
    stock: { column: 21 },
    maxFrequency: 22,
    dailyStock: 23,
    monthlyStock: 24,
    rewardStarts: [25, 28, 31, 34, 37, 40],
}

const TREASURE_LAYOUT: ShopLayout = {
    tableName: "treasure_shop",
    columnCount: 44,
    priceStart: 7,
    costStarts: [10, 12, 14, 16],
    availableFrom: 18,
    availableUntil: 19,
    stock: { column: 21 },
    maxFrequency: 22,
    dailyStock: 23,
    rewardStarts: [24, 27, 30, 33, 36, 39],
}

const EQUIPMENT_LAYOUT: ShopLayout = {
    tableName: "equipment_enhancement_shop",
    columnCount: 50,
    priceStart: 11,
    costStarts: [14, 16, 18, 20],
    availableFrom: 22,
    availableUntil: 23,
    stock: { column: 25, emptyValue: -1 },
    maxFrequency: 26,
    dailyStock: 27,
    monthlyStock: 28,
    rewardStarts: [32, 35, 38, 41, 44, 47],
}

function convertSpecialPackShop(rows: readonly OrderedMapTextRow[]): ShopItems {
    const parsed = requireRows(rows, "special_pack_shop", 46)
    const result: ShopItems = {}
    for (const [id, fields] of parsed) {
        const kind = parseOptionalInteger(fields[27], `special_pack_shop[${id}].kind1`)
        const points = parseOptionalInteger(fields[29], `special_pack_shop[${id}].kind1.count`)
        const priceKind = parseOptionalInteger(fields[9], `special_pack_shop[${id}].priceKind`)
        const price = parseOptionalInteger(fields[10], `special_pack_shop[${id}].price`)
        if (kind !== 6 || points === undefined || priceKind !== 0 || price === undefined) continue
        const item: ShopItem = {
            costs: [],
            rewards: [],
            availableFrom: parseDate(fields[20], `special_pack_shop[${id}].availableFrom`),
            availableUntil: parseOptionalDate(fields[21], `special_pack_shop[${id}].availableUntil`),
            stock: parseInteger(fields[23], `special_pack_shop[${id}].buyMaxCount`),
            userCost: { type: ShopItemUserCostType.PAID_BEADS, amount: price },
            passCardPoints: points,
        }
        for (const [fieldName, column] of [
            ["maxFrequency", 24],
            ["dailyStock", 25],
            ["monthlyStock", 26],
        ] as const) {
            const value = parseOptionalInteger(fields[column], `special_pack_shop[${id}].${fieldName}`)
            if (value !== undefined) item[fieldName] = value
        }
        result[id] = item
    }
    return result
}

function invalidShop(reason: string): never {
    throw new Error(`invalid shop content: ${reason}`)
}

function compareCanonicalIds(left: string, right: string): number {
    const lengthDifference = left.length - right.length
    if (lengthDifference !== 0) return lengthDifference
    return left < right ? -1 : left > right ? 1 : 0
}

function requireRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): ParsedRow[] {
    const seen = new Set<string>()
    return [...rows]
        .sort((left, right) => compareCanonicalIds(left.key, right.key))
        .map(row => {
            if (!POSITIVE_INTEGER_PATTERN.test(row.key)) {
                invalidShop(`${tableName} key must be a canonical positive integer: ${row.key}`)
            }
            if (seen.has(row.key)) invalidShop(`${tableName} has duplicate key: ${row.key}`)
            seen.add(row.key)
            const parsed = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidShop)
            if (parsed.length !== columnCount) {
                invalidShop(
                    `${tableName}[${row.key}] must have ${columnCount} columns, got ${parsed.length}`,
                )
            }
            return [row.key, parsed] as const
        })
}

function parseInteger(value: string, subject: string): number {
    if (!INTEGER_PATTERN.test(value)) invalidShop(`${subject} must be an integer: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidShop(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parseOptionalInteger(value: string, subject: string): number | undefined {
    return value === "" || value === "(None)" ? undefined : parseInteger(value, subject)
}

function parseOptionalMonths(value: string, subject: string): number[] | undefined {
    if (value === "" || value === "(None)") return undefined
    const months = value.split(",").map((part, index) => {
        const month = parseInteger(part, `${subject}[${index}]`)
        if (month < 1 || month > 12) invalidShop(`${subject}[${index}] must be 1 through 12`)
        return month
    })
    if (new Set(months).size !== months.length) invalidShop(`${subject} contains duplicates`)
    if (months.some((month, index) => index > 0 && month <= months[index - 1])) {
        invalidShop(`${subject} must be strictly ascending`)
    }
    return months
}

function parseDate(value: string, subject: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) {
        invalidShop(`${subject} must be a CN date-time: ${value}`)
    }
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const normalized = new Date(0)
    normalized.setUTCFullYear(year, month - 1, day)
    normalized.setUTCHours(hour, minute, second, 0)
    const normalizedParts = [
        normalized.getUTCFullYear(),
        normalized.getUTCMonth() + 1,
        normalized.getUTCDate(),
        normalized.getUTCHours(),
        normalized.getUTCMinutes(),
        normalized.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalizedParts[index])) {
        invalidShop(`${subject} must be a valid CN date-time: ${value}`)
    }
    return value
}

function parseOptionalDate(value: string, subject: string): string | null {
    return value === "" || value === "(None)" ? null : parseDate(value, subject)
}

function parseStock(fields: readonly string[], layout: ShopLayout, subject: string): number {
    const value = fields[layout.stock.column]
    if ((value === "" || value === "(None)") && layout.stock.emptyValue !== undefined) {
        return layout.stock.emptyValue
    }
    return parseInteger(value, `${subject}.stock`)
}

function parseCosts(fields: readonly string[], starts: readonly number[], subject: string) {
    return starts.flatMap(start => {
        const id = parseOptionalInteger(fields[start], `${subject}.cost[${start}].id`)
        const amount = parseOptionalInteger(fields[start + 1], `${subject}.cost[${start}].amount`)
        if (id === undefined && amount === undefined) return []
        if (id === undefined || amount === undefined) {
            return invalidShop(`${subject}.cost[${start}] must contain both id and amount`)
        }
        return [{ id, amount }]
    })
}

function parseRewards(fields: readonly string[], starts: readonly number[], subject: string) {
    return starts.flatMap(start => {
        const type = parseOptionalInteger(fields[start], `${subject}.reward[${start}].type`)
        const id = parseOptionalInteger(fields[start + 1], `${subject}.reward[${start}].id`)
        const count = parseOptionalInteger(fields[start + 2], `${subject}.reward[${start}].count`)
        if (type === undefined && id === undefined && count === undefined) return []
        if (type === undefined || count === undefined || type < 0 || type > 4) {
            return invalidShop(`${subject}.reward[${start}] has an invalid type/count shape`)
        }
        if (type === 1 || type === 2) {
            if (id !== undefined) invalidShop(`${subject}.reward[${start}] currency id must be empty`)
            return [{ type, count }]
        }
        if (id === undefined) invalidShop(`${subject}.reward[${start}] id must be present`)
        return [{ type, id, count }]
    })
}

function parseUserCost(
    fields: readonly string[],
    start: number | undefined,
    subject: string,
) {
    if (start === undefined) return undefined
    const type = parseOptionalInteger(fields[start], `${subject}.userCost.type`)
    const amount = parseOptionalInteger(fields[start + 1], `${subject}.userCost.amount`)
    if (type === undefined && amount === undefined) return undefined
    if (type === undefined || amount === undefined || type < 0 || type > 2) {
        return invalidShop(`${subject}.userCost has an invalid type/amount shape`)
    }
    return { type, amount }
}

function parseShopItem(fields: readonly string[], layout: ShopLayout, id: string): ShopItem {
    const subject = `${layout.tableName}[${id}]`
    const item: ShopItem = {
        costs: parseCosts(fields, layout.costStarts, subject),
        rewards: parseRewards(fields, layout.rewardStarts, subject),
        availableFrom: parseDate(fields[layout.availableFrom], `${subject}.availableFrom`),
        availableUntil: parseOptionalDate(
            fields[layout.availableUntil],
            `${subject}.availableUntil`,
        ),
        stock: parseStock(fields, layout, subject),
    }
    const userCost = parseUserCost(fields, layout.priceStart, subject)
    if (userCost !== undefined) item.userCost = userCost
    for (const [fieldName, column] of [
        ["maxFrequency", layout.maxFrequency],
        ["dailyStock", layout.dailyStock],
        ["monthlyStock", layout.monthlyStock],
    ] as const) {
        if (column === undefined) continue
        const value = parseOptionalInteger(fields[column], `${subject}.${fieldName}`)
        if (value !== undefined) item[fieldName] = value
    }
    if (layout.specifiedMonths !== undefined) {
        const specifiedMonths = parseOptionalMonths(
            fields[layout.specifiedMonths],
            `${subject}.specifiedMonths`,
        )
        if (specifiedMonths !== undefined) item.specifiedMonths = specifiedMonths
    }
    return item
}

function convertFlatShop(rows: readonly ParsedRow[], layout: ShopLayout): ShopItems {
    return Object.fromEntries(rows.map(([id, fields]) => [id, parseShopItem(fields, layout, id)]))
}

function categoryIds(rows: readonly ParsedRow[]): ReadonlySet<string> {
    return new Set(rows.map(([id]) => id))
}

function requireCategory(
    categories: ReadonlySet<string>,
    categoryId: string,
    tableName: string,
): void {
    if (!categories.has(categoryId)) {
        invalidShop(`${tableName} references undeclared category ${categoryId}`)
    }
}

function parseCampaignReference(
    fields: readonly string[],
    campaignColumn: number,
    lineupColumn: number,
    subject: string,
): Pick<ShopItem, "campaignId" | "lineupId"> {
    const campaignId = parseOptionalInteger(fields[campaignColumn], `${subject}.campaignId`)
    const lineupId = parseOptionalInteger(fields[lineupColumn], `${subject}.lineupId`)
    if (campaignId === undefined && lineupId === undefined) return {}
    if (campaignId === undefined) {
        invalidShop(`${subject}.lineupId requires campaignId`)
    }
    return lineupId === undefined ? { campaignId } : { campaignId, lineupId }
}

function convertSelectCampaigns(
    campaignRows: readonly ParsedRow[],
    lineupRows: readonly ParsedRow[],
    tableName: string,
): Record<string, { availableFrom: string; availableUntil: string; lineupIds: number[] }> {
    const campaigns: Record<
        string,
        { availableFrom: string; availableUntil: string; lineupIds: number[] }
    > = {}
    for (const [campaignId, fields] of campaignRows) {
        const exchangeableUntil = parseOptionalDate(
            fields[8],
            `${tableName}[${campaignId}].exchangeableUntil`,
        )
        campaigns[campaignId] = {
            availableFrom: parseDate(fields[6], `${tableName}[${campaignId}].availableFrom`),
            availableUntil: exchangeableUntil
                ?? parseDate(fields[7], `${tableName}[${campaignId}].availableUntil`),
            lineupIds: [],
        }
    }
    for (const [lineupId, fields] of lineupRows) {
        const campaignId = String(parseInteger(
            fields[0],
            `${tableName}_lineup[${lineupId}].campaignId`,
        ))
        const campaign = campaigns[campaignId]
        if (campaign === undefined) {
            invalidShop(`${tableName}_lineup[${lineupId}] references campaign ${campaignId}`)
        }
        campaign.lineupIds.push(parseInteger(lineupId, `${tableName}_lineup.lineupId`))
    }
    return campaigns
}

function requireCampaignItemReference(
    item: ShopItem,
    campaigns: Readonly<Record<string, { readonly lineupIds: readonly number[] }>>,
    subject: string,
): void {
    if (item.campaignId === undefined && item.lineupId === undefined) return
    const campaign = campaigns[String(item.campaignId)]
    if (campaign === undefined
        || (item.lineupId !== undefined && !campaign.lineupIds.includes(item.lineupId))) {
        invalidShop(`${subject} references an unknown campaign lineup`)
    }
}

export async function convertShops(reader: ShopSourceReader): Promise<ShopConversionOutput> {
    const generalRows = requireRows(await reader.read(GENERAL_SHOP_PATH), "general_shop", 47)
    const eventRows = requireRows(await reader.read(EVENT_ITEM_SHOP_PATH), "event_item_shop", 51)
    const eventCampaignRows = requireRows(
        await reader.read(EVENT_SELECT_CAMPAIGN_PATH),
        "event_shop_select_item_campaign",
        13,
    )
    const eventLineupRows = requireRows(
        await reader.read(EVENT_SELECT_LINEUP_PATH),
        "event_shop_select_item_campaign_lineup",
        3,
    )
    const bossRows = requireRows(await reader.read(BOSS_COIN_SHOP_PATH), "boss_coin_shop", 50)
    const bossCategoryRows = requireRows(
        await reader.read(BOSS_COIN_SHOP_CATEGORY_PATH),
        "boss_coin_shop_category",
        13,
    )
    const bossCampaignRows = requireRows(
        await reader.read(BOSS_SELECT_CAMPAIGN_PATH),
        "boss_coin_shop_select_item_campaign",
        13,
    )
    const bossLineupRows = requireRows(
        await reader.read(BOSS_SELECT_LINEUP_PATH),
        "boss_coin_shop_select_item_campaign_lineup",
        6,
    )
    const starGrainRows = requireRows(
        await reader.read(STAR_GRAIN_SHOP_PATH),
        "star_grain_shop",
        43,
    )
    const treasureRows = requireRows(
        await reader.read(TREASURE_SHOP_PATH),
        "treasure_shop",
        44,
    )
    const equipmentRows = requireRows(
        await reader.read(EQUIPMENT_ENHANCEMENT_SHOP_PATH),
        "equipment_enhancement_shop",
        50,
    )
    const equipmentCategoryRows = requireRows(
        await reader.read(EQUIPMENT_ENHANCEMENT_SHOP_CATEGORY_PATH),
        "equipment_enhancement_shop_category",
        10,
    )
    const specialPackRows = await reader.read(SPECIAL_PACK_SHOP_PATH)

    const shopSelectItemCampaigns: ShopSelectItemCampaigns = {
        "4": convertSelectCampaigns(
            eventCampaignRows,
            eventLineupRows,
            "event_shop_select_item_campaign",
        ),
        "7": convertSelectCampaigns(
            bossCampaignRows,
            bossLineupRows,
            "boss_coin_shop_select_item_campaign",
        ),
    }
    const shopItemCampaignMap: ShopItemCampaignMap = { "4": {}, "7": {} }
    const eventItemShop: EventShopItems = {}
    const eventItemShopIdMap: Record<string, { eventType: number; eventId: number }> = {}
    for (const [id, fields] of eventRows) {
        const eventId = parseInteger(fields[1], `event_item_shop[${id}].eventId`)
        const eventType = parseInteger(fields[2], `event_item_shop[${id}].eventType`)
        eventItemShop[String(eventType)] ??= {}
        eventItemShop[String(eventType)][String(eventId)] ??= {}
        const item = parseShopItem(
            fields,
            EVENT_LAYOUT,
            id,
        )
        Object.assign(item, parseCampaignReference(fields, 4, 5, `event_item_shop[${id}]`))
        requireCampaignItemReference(item, shopSelectItemCampaigns["4"], `event_item_shop[${id}]`)
        if (item.campaignId !== undefined) {
            shopItemCampaignMap["4"][id] = item.lineupId === undefined
                ? { campaignId: item.campaignId }
                : { campaignId: item.campaignId, lineupId: item.lineupId }
        }
        eventItemShop[String(eventType)][String(eventId)][id] = item
        eventItemShopIdMap[id] = { eventType, eventId }
    }

    const bossCategories = categoryIds(bossCategoryRows)
    const bossCoinShop: BossCoinShopItems = Object.fromEntries(
        bossCategoryRows.map(([id]) => [id, {}]),
    )
    const bossCoinShopItemCategoryMap: Record<string, number> = {}
    for (const [id, fields] of bossRows) {
        const categoryId = fields[0]
        requireCategory(bossCategories, categoryId, "boss_coin_shop")
        const item = parseShopItem(fields, BOSS_LAYOUT, id)
        Object.assign(item, parseCampaignReference(fields, 3, 4, `boss_coin_shop[${id}]`))
        requireCampaignItemReference(item, shopSelectItemCampaigns["7"], `boss_coin_shop[${id}]`)
        if (item.campaignId !== undefined) {
            shopItemCampaignMap["7"][id] = item.lineupId === undefined
                ? { campaignId: item.campaignId }
                : { campaignId: item.campaignId, lineupId: item.lineupId }
        }
        bossCoinShop[categoryId][id] = item
        bossCoinShopItemCategoryMap[id] = parseInteger(
            categoryId,
            `boss_coin_shop[${id}].category`,
        )
    }

    const equipmentCategories = categoryIds(equipmentCategoryRows)
    const equipmentEnhancementShop: ShopItems = {}
    for (const [id, fields] of equipmentRows) {
        const categoryId = fields[0]
        requireCategory(equipmentCategories, categoryId, "equipment_enhancement_shop")
        const productKind = parseInteger(fields[4], `equipment_enhancement_shop[${id}].kind`)
        if (productKind !== 0 && productKind !== 1) {
            invalidShop(`equipment_enhancement_shop[${id}].kind must be 0 or 1`)
        }
        const item = parseShopItem(fields, EQUIPMENT_LAYOUT, id)
        item.shopCategoryId = parseInteger(
            categoryId,
            `equipment_enhancement_shop[${id}].category`,
        )
        item.groupId = parseInteger(fields[2], `equipment_enhancement_shop[${id}].groupId`)
        item.stage = parseInteger(fields[3], `equipment_enhancement_shop[${id}].stage`)
        if (productKind === 1) {
            item.equipmentId = parseInteger(
                fields[29],
                `equipment_enhancement_shop[${id}].equipmentId`,
            )
            item.enhancementMaxLevel = parseInteger(
                fields[30],
                `equipment_enhancement_shop[${id}].enhancementMaxLevel`,
            )
            item.requireAwakeningLevel = parseInteger(
                fields[31],
                `equipment_enhancement_shop[${id}].requireAwakeningLevel`,
            )
        }
        equipmentEnhancementShop[id] = item
    }

    return deepFreeze({
        "general_shop.json": convertFlatShop(generalRows, GENERAL_LAYOUT),
        "event_item_shop.json": eventItemShop,
        "event_item_shop_id_map.json": eventItemShopIdMap,
        "boss_coin_shop.json": bossCoinShop,
        "boss_coin_shop_item_category_map.json": bossCoinShopItemCategoryMap,
        "shop_select_item_campaign.json": shopSelectItemCampaigns,
        "shop_item_campaign.json": shopItemCampaignMap,
        "star_grain_shop.json": convertFlatShop(starGrainRows, STAR_GRAIN_LAYOUT),
        "treasure_shop.json": convertFlatShop(treasureRows, TREASURE_LAYOUT),
        "equipment_enhancement_shop.json": equipmentEnhancementShop,
        "special_pack_shop.json": convertSpecialPackShop(specialPackRows),
    })
}
