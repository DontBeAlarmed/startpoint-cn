import type { OrderedMapTextRow } from "../../sync/ordered-map"
import {
    ShopItemRewardType,
    type ShopItemReward,
} from "../../../lib/types/rewards"
import {
    ShopItemUserCostType,
    type ShopItem,
    type ShopItems,
} from "../../../lib/types/shop"
import {
    invalidShop,
    parseOptionalShopInteger,
    parseShopCosts,
    parseShopDate,
    parseShopInteger,
    parseOptionalShopDate,
    requireShopRows,
} from "./parser"

function positive(value: number, subject: string): number {
    if (value <= 0) invalidShop(`${subject} must be positive`)
    return value
}

function parseSpecialRewards(fields: readonly string[], subject: string): {
    readonly rewards: ShopItemReward[]
    readonly passCardPoints?: number
} {
    const rewards: ShopItemReward[] = []
    let passCardPoints: number | undefined
    for (const start of [27, 30, 33, 36, 39, 42]) {
        const kind = parseOptionalShopInteger(fields[start], `${subject}.kind[${start}]`)
        const id = parseOptionalShopInteger(fields[start + 1], `${subject}.kind[${start}].id`)
        const count = parseOptionalShopInteger(fields[start + 2], `${subject}.kind[${start}].count`)
        if (kind === undefined && id === undefined && count === undefined) continue
        if (kind === undefined || count === undefined) {
            invalidShop(`${subject}.kind[${start}] has an invalid shape`)
        }
        const amount = positive(count, `${subject}.kind[${start}].count`)
        if (kind === 6) {
            if (id !== undefined || passCardPoints !== undefined) {
                invalidShop(`${subject}.kind[${start}] has an invalid Pass Card Point shape`)
            }
            passCardPoints = amount
            continue
        }
        if (kind < 0 || kind > 4) {
            invalidShop(`${subject}.kind[${start}] is not used by current CN Shop Content`)
        }
        if (kind === ShopItemRewardType.EXP || kind === ShopItemRewardType.MANA) {
            if (id !== undefined) invalidShop(`${subject}.kind[${start}] currency id must be empty`)
            rewards.push({ type: kind, count: amount } as ShopItemReward)
            continue
        }
        if (id === undefined || id <= 0) invalidShop(`${subject}.kind[${start}] id must be present`)
        rewards.push({ type: kind, id, count: amount } as ShopItemReward)
    }
    return { rewards, ...(passCardPoints === undefined ? {} : { passCardPoints }) }
}

export function convertSpecialPackShop(rows: readonly OrderedMapTextRow[]): ShopItems {
    const parsed = requireShopRows(rows, "special_pack_shop", 46)
    return Object.fromEntries(parsed.map(([id, fields]) => {
        const subject = `special_pack_shop[${id}]`
        const specialExchangeCampaignId = parseShopInteger(
            fields[1],
            `${subject}.specialExchangeCampaignId`,
        )
        if (specialExchangeCampaignId < 0) {
            invalidShop(`${subject}.specialExchangeCampaignId must be non-negative`)
        }
        const priceKind = parseShopInteger(fields[9], `${subject}.priceKind`)
        const price = positive(parseShopInteger(fields[10], `${subject}.price`), `${subject}.price`)
        if (priceKind !== 0) invalidShop(`${subject}.priceKind must be paid Stone in current CN Content`)
        const parsedRewards = parseSpecialRewards(fields, subject)
        const item: ShopItem = {
            costs: parseShopCosts(fields, [12, 14, 16, 18], subject),
            rewards: parsedRewards.rewards,
            availableFrom: parseShopDate(fields[20], `${subject}.availableFrom`),
            availableUntil: parseOptionalShopDate(fields[21], `${subject}.availableUntil`),
            stock: positive(parseShopInteger(fields[23], `${subject}.stock`), `${subject}.stock`),
            userCost: { type: ShopItemUserCostType.PAID_BEADS, amount: price },
            purchaseKind: specialExchangeCampaignId === 0
                ? "purchase"
                : "specialExchangeLink",
            specialExchangeCampaignId,
            ...(parsedRewards.passCardPoints === undefined
                ? {}
                : { passCardPoints: parsedRewards.passCardPoints }),
        }
        for (const [fieldName, column] of [
            ["maxFrequency", 24],
            ["dailyStock", 25],
            ["monthlyStock", 26],
        ] as const) {
            const value = parseOptionalShopInteger(fields[column], `${subject}.${fieldName}`)
            if (value !== undefined) item[fieldName] = value
        }
        return [id, item]
    }))
}

export function convertManaShop(rows: readonly OrderedMapTextRow[]): ShopItems {
    const parsed = requireShopRows(rows, "mana_shop", 24)
    return Object.fromEntries(parsed.map(([id, fields]) => {
        const subject = `mana_shop[${id}]`
        const priceKind = parseShopInteger(fields[3], `${subject}.priceKind`)
        const price = positive(parseShopInteger(fields[4], `${subject}.price`), `${subject}.price`)
        if (priceKind !== 0) invalidShop(`${subject}.priceKind must be Stone in current CN Content`)
        const purchaseCount = positive(
            parseShopInteger(fields[20], `${subject}.purchaseCount`),
            `${subject}.purchaseCount`,
        )
        const additionalCount = parseShopInteger(fields[21], `${subject}.additionalCount`)
        if (additionalCount < 0 || !Number.isSafeInteger(purchaseCount + additionalCount)) {
            invalidShop(`${subject}.Mana reward is invalid`)
        }
        const item: ShopItem = {
            costs: parseShopCosts(fields, [6, 8, 10, 12], subject),
            rewards: [{
                type: ShopItemRewardType.MANA,
                count: purchaseCount + additionalCount,
            } as ShopItemReward],
            availableFrom: parseShopDate(fields[14], `${subject}.availableFrom`),
            availableUntil: parseOptionalShopDate(fields[15], `${subject}.availableUntil`),
            stock: positive(parseShopInteger(fields[17], `${subject}.stock`), `${subject}.stock`),
            userCost: { type: ShopItemUserCostType.BEADS, amount: price },
        }
        const costScheduleId = fields[5]
        if (costScheduleId !== "" && costScheduleId !== "(None)") item.costScheduleId = costScheduleId
        for (const [fieldName, column] of [
            ["maxFrequency", 18],
            ["dailyStock", 19],
        ] as const) {
            const value = parseOptionalShopInteger(fields[column], `${subject}.${fieldName}`)
            if (value !== undefined) item[fieldName] = value
        }
        return [id, item]
    }))
}
