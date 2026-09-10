import { ShopType, type ShopItem } from "./types/shop"
import { shopCatalogKey, type ShopCatalog } from "./shop/model"

/**
 * Shared private-server content override for the CN final-operation Rush batch.
 *
 * Official master data ships `700011`-`700017` (internal names
 * `combat_diver_constant_1..7`) with empty folder clear rewards and no
 * event shop rows. This module is the explicit private input that
 * re-exposes the `700001`-`700007` batch content for those events; it is
 * composed at query time and never written back into the official
 * Content Snapshot, the raw CN asset baseline or the CDN archives.
 */

export interface RushFinalOperationOverrideEvent {
    readonly provenance: "PRIVATE_OVERRIDE"
    readonly targetEventId: number
    readonly sourceEventId: number
    readonly availableFrom: string
    readonly availableUntil: string
}

export type RushFinalOperationOverride = Readonly<Record<number, RushFinalOperationOverrideEvent>>

export const RUSH_EVENT_TYPE = 11

const RUSH_FINAL_OPERATION_EVENT_COUNT = 7
const FIRST_TARGET_EVENT_ID = 700011
const TARGET_TO_SOURCE_EVENT_OFFSET = 10

export const RUSH_FINAL_OPERATION_OVERRIDE: RushFinalOperationOverride = Object.freeze(
    Object.fromEntries(
        Array.from({ length: RUSH_FINAL_OPERATION_EVENT_COUNT }, (_, index) => {
            const targetEventId = FIRST_TARGET_EVENT_ID + index
            return [targetEventId, Object.freeze({
                provenance: "PRIVATE_OVERRIDE",
                targetEventId,
                sourceEventId: targetEventId - TARGET_TO_SOURCE_EVENT_OFFSET,
                availableFrom: "2025-06-26 12:00:00",
                availableUntil: "2025-08-14 23:59:59",
            })]
        }),
    ),
)

/**
 * Single typed control for the whole override. A disabled policy yields
 * `null` and every consumer composes from official content only, so the
 * three compatibility dimensions (folder rewards, shop list, purchase
 * period) can never end up in a partially enabled state.
 */
export function resolveRushFinalOperationOverride(
    enabled: boolean,
): RushFinalOperationOverride | null {
    return enabled ? RUSH_FINAL_OPERATION_OVERRIDE : null
}

export function getRushFinalOperationOverrideEvent(
    override: RushFinalOperationOverride | null,
    targetEventId: number,
): RushFinalOperationOverrideEvent | null {
    if (override === null) return null
    const event = override[targetEventId]
    return event === undefined ? null : event
}

/**
 * Resolves the override for a source event's own shop items, but only
 * while the corresponding target event has no exact official products.
 * Exact official rows always win over the compatibility fallback.
 */
export function getRushFinalOperationOverrideForSourceEvent(
    catalog: Pick<ShopCatalog, "eventProductIds">,
    override: RushFinalOperationOverride | null,
    sourceEventId: number,
): RushFinalOperationOverrideEvent | null {
    if (override === null) return null
    for (const event of Object.values(override)) {
        if (event.sourceEventId !== sourceEventId) continue
        const targetProducts = catalog.eventProductIds[`${RUSH_EVENT_TYPE}:${event.targetEventId}`]
        return targetProducts !== undefined && targetProducts.length > 0 ? null : event
    }
    return null
}

/**
 * Returns whether a purchase can require the runtime compatibility setting.
 *
 * The catalog is the cheap, immutable boundary: ordinary shops, unrelated
 * event shops and non-Rush event products must not read server settings just
 * because the route accepts an event-shop request.
 */
export function isRushFinalOperationOverridePurchaseCandidate(
    catalog: Pick<ShopCatalog, "entries" | "eventProductIds">,
    shopType: number,
    shopItemIds: readonly number[],
): boolean {
    if (shopType !== ShopType.EVENT_ITEM) return false
    return shopItemIds.some(shopItemId => {
        const entry = catalog.entries[shopCatalogKey(shopType, shopItemId)]
        if (entry === undefined
            || entry.kind !== "purchase"
            || entry.scope.kind !== "event"
            || entry.scope.eventType !== RUSH_EVENT_TYPE) return false
        return getRushFinalOperationOverrideForSourceEvent(
            catalog,
            RUSH_FINAL_OPERATION_OVERRIDE,
            entry.scope.eventId,
        ) !== null
    })
}

export function addRushFinalOperationCompatibilityPeriod(
    item: ShopItem,
    event: RushFinalOperationOverrideEvent,
): ShopItem {
    const compatibilityPeriod = {
        availableFrom: event.availableFrom,
        availableUntil: event.availableUntil,
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

export interface RushFinalOperationEventView {
    readonly productIds: readonly number[]
    readonly itemTransform: ((item: ShopItem) => ShopItem) | null
}

/**
 * Composes one event shop view: official products pass through untouched,
 * while the private override (when enabled) either substitutes the source
 * batch's products for an empty target event or exposes the source batch's
 * own items with the compatibility purchase period attached.
 */
export function resolveRushFinalOperationEventView(
    catalog: Pick<ShopCatalog, "eventProductIds">,
    override: RushFinalOperationOverride | null,
    eventType: number,
    eventId: number,
    officialProductIds: readonly number[],
): RushFinalOperationEventView {
    if (override === null || eventType !== RUSH_EVENT_TYPE) {
        return { productIds: officialProductIds, itemTransform: null }
    }
    const target = getRushFinalOperationOverrideEvent(override, eventId)
    if (target !== null && officialProductIds.length === 0) {
        return {
            productIds: catalog.eventProductIds[`${RUSH_EVENT_TYPE}:${target.sourceEventId}`] ?? [],
            itemTransform: item => addRushFinalOperationCompatibilityPeriod(item, target),
        }
    }
    const source = getRushFinalOperationOverrideForSourceEvent(catalog, override, eventId)
    if (source !== null) {
        return {
            productIds: officialProductIds,
            itemTransform: item => addRushFinalOperationCompatibilityPeriod(item, source),
        }
    }
    return { productIds: officialProductIds, itemTransform: null }
}
