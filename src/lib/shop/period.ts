import type { ShopItem, ShopItemAvailabilityPeriod } from "../types/shop"

const CN_OFFSET_MS = 8 * 60 * 60 * 1000

export class ShopPeriodFormatError extends Error {}

export function parseShopCnTimestamp(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) {
        throw new ShopPeriodFormatError(`Invalid shop period: ${value}.`)
    }

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
    const [year, month, day, hour, minute, second] = parts
    const localDate = new Date(0)
    localDate.setUTCFullYear(year, month - 1, day)
    localDate.setUTCHours(hour, minute, second, 0)
    const normalized = [
        localDate.getUTCFullYear(),
        localDate.getUTCMonth() + 1,
        localDate.getUTCDate(),
        localDate.getUTCHours(),
        localDate.getUTCMinutes(),
        localDate.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        throw new ShopPeriodFormatError(`Invalid shop period: ${value}.`)
    }
    return localDate.getTime() - CN_OFFSET_MS
}

export function getShopCnMonth(nowMs: number): number {
    if (!Number.isFinite(nowMs)) throw new ShopPeriodFormatError("Invalid shop time.")
    return new Date(nowMs + CN_OFFSET_MS).getUTCMonth() + 1
}

export function isShopPeriodAvailable(
    period: Readonly<ShopItemAvailabilityPeriod>,
    nowMs: number,
): boolean {
    const availableFromMs = parseShopCnTimestamp(period.availableFrom)
    const availableUntilMs = period.availableUntil === null
        ? Infinity
        : parseShopCnTimestamp(period.availableUntil)
    return nowMs >= availableFromMs && nowMs <= availableUntilMs
}

export function isShopItemAvailable(shopItem: ShopItem, nowMs: number): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]
    return periods.some(period => isShopPeriodAvailable(period, nowMs))
}
