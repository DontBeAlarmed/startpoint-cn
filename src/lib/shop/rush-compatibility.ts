import type { ShopItem, ShopItems } from "../types/shop"

export interface RushCompatibilityEvent {
    readonly sourceEventId: number
    readonly availableFrom: string
    readonly availableUntil: string
}

export const RUSH_COMPATIBILITY_EVENTS: Readonly<Record<number, RushCompatibilityEvent>> =
    Object.freeze(Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [700011 + index, Object.freeze({
            sourceEventId: 700001 + index,
            availableFrom: "2025-06-26 12:00:00",
            availableUntil: "2025-08-14 23:59:59",
        })]),
    ))

export function getRushCompatibilityEvent(
    eventId: number | string,
): RushCompatibilityEvent | null {
    const numericEventId = Number(eventId)
    return Number.isInteger(numericEventId)
        ? RUSH_COMPATIBILITY_EVENTS[numericEventId] ?? null
        : null
}

export function addRushCompatibilityPeriod(
    item: ShopItem,
    compatibility: RushCompatibilityEvent,
): ShopItem {
    const compatibilityPeriod = {
        availableFrom: compatibility.availableFrom,
        availableUntil: compatibility.availableUntil,
    }
    const existingPeriods = item.compatibilityPeriods ?? []
    const compatibilityPeriods = existingPeriods.some(period => (
        period.availableFrom === compatibilityPeriod.availableFrom
        && period.availableUntil === compatibilityPeriod.availableUntil
    ))
        ? existingPeriods
        : [...existingPeriods, compatibilityPeriod]

    return {
        ...item,
        compatibilityPeriods,
    }
}

export function addRushCompatibilityPeriods(
    items: ShopItems,
    compatibility: RushCompatibilityEvent,
): ShopItems {
    return Object.fromEntries(Object.entries(items).map(([itemId, item]) => [
        itemId,
        addRushCompatibilityPeriod(item, compatibility),
    ]))
}
