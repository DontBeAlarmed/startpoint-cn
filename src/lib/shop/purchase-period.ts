import { getDayBucket } from "../time-utils"

export interface ShopPurchasePeriodKeys {
    readonly daily: string
    readonly monthly: string
}

export interface ShopPurchaseCountQuery {
    readonly shopType: number
    readonly shopItemId: number
    readonly keys: ShopPurchasePeriodKeys
    readonly key: string
}

function pad2(value: number): string {
    return String(value).padStart(2, "0")
}

export function getShopPurchasePeriodKeys(
    nowMs: number,
    specifiedMonths: readonly number[] | undefined,
    resetHour = 5,
): ShopPurchasePeriodKeys {
    const bucket = getDayBucket(new Date(nowMs), resetHour)
    const year = bucket.y
    const month = bucket.m + 1
    const daily = `${year}-${pad2(month)}-${pad2(bucket.d)}`
    if (!specifiedMonths || specifiedMonths.length === 0) {
        return { daily, monthly: `${year}-${pad2(month)}` }
    }
    const validMonths = specifiedMonths.filter(value => (
        Number.isSafeInteger(value) && value >= 1 && value <= 12
    ))
    if (validMonths.length !== specifiedMonths.length) {
        throw new TypeError("Shop specified months are invalid.")
    }
    const previous = [...validMonths].reverse().find(value => value <= month)
    const periodYear = previous === undefined ? year - 1 : year
    const periodMonth = previous ?? validMonths[validMonths.length - 1]
    return { daily, monthly: `specified:${periodYear}-${pad2(periodMonth)}` }
}

export function getShopPurchaseQueryKey(
    query: Pick<ShopPurchaseCountQuery, "shopType" | "shopItemId" | "keys">,
): string {
    return `${query.shopType}:${query.shopItemId}:${query.keys.daily}:${query.keys.monthly}`
}

export function createShopPurchaseCountQuery(
    shopType: number,
    shopItemId: number,
    keys: ShopPurchasePeriodKeys,
): ShopPurchaseCountQuery {
    const query = { shopType, shopItemId, keys }
    return { ...query, key: getShopPurchaseQueryKey(query) }
}
