import type { ShopItem, ShopItemAvailabilityPeriod } from "../types/shop"
import { GameCalendarError, type GameCalendarPolicy } from "../../time/game-calendar"
import { getGameCalendar } from "../../time/game-calendar-provider"

export class ShopPeriodFormatError extends Error {}

export function parseShopCnTimestamp(
    value: string,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) {
            throw new ShopPeriodFormatError(`Invalid shop period: ${value}.`)
        }
        throw error
    }
}

export function getShopCnMonth(
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    if (!Number.isFinite(nowMs)) throw new ShopPeriodFormatError("Invalid shop time.")
    return calendar.getMonth(nowMs)
}

export function isShopPeriodAvailable(
    period: Readonly<ShopItemAvailabilityPeriod>,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const availableFromMs = parseShopCnTimestamp(period.availableFrom, calendar)
    const availableUntilMs = period.availableUntil === null
        ? Infinity
        : parseShopCnTimestamp(period.availableUntil, calendar)
    return nowMs >= availableFromMs && nowMs <= availableUntilMs
}

export function isShopItemAvailable(
    shopItem: ShopItem,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]
    return periods.some(period => isShopPeriodAvailable(period, nowMs, calendar))
}
