import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import { GameCalendarError, type GameCalendarPolicy } from "../../time/game-calendar"
import { getGameCalendar } from "../../time/game-calendar-provider"

export interface BondTokenExchangeProduct {
    readonly equipmentId: number
    readonly cost: number
    readonly stock: number
    readonly availableFromMs: number
    readonly availableUntilMs: number
}

// Cached catalogs are keyed by repository identity and by the calendar offset
// they were parsed under, so a catalog parsed under one offset can never be
// served for another.
const catalogs = new WeakMap<ReadonlyContentRepository, Map<number, BondTokenCatalog>>()

function parseNonNegativeSafeInteger(value: unknown, subject: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Bond token exchange ${subject} is invalid: ${value}`)
    }
    return parsed
}

function parsePositiveSafeInteger(value: unknown, subject: string): number {
    const parsed = parseNonNegativeSafeInteger(value, subject)
    if (parsed === 0) {
        throw new Error(`Bond token exchange ${subject} is invalid: ${value}`)
    }
    return parsed
}

export type BondTokenExchangeProductResolution =
    | { readonly ok: true; readonly product: BondTokenExchangeProduct }
    | { readonly ok: false; readonly kind: "notFound" }
    | { readonly ok: false; readonly kind: "outOfPeriod" }

interface BondTokenCatalog {
    readonly resolve: (
        equipmentId: number,
        nowMs: number,
    ) => BondTokenExchangeProductResolution
    readonly list: (nowMs: number) => readonly BondTokenExchangeProduct[]
}

function parseCnPeriodTimestamp(
    value: string,
    subject: string,
    calendar: GameCalendarPolicy,
): number {
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) {
            throw new Error(`Bond token exchange ${subject} is invalid: ${value}`)
        }
        throw error
    }
}

function buildBondTokenCatalog(
    repository: ReadonlyContentRepository,
    calendar: GameCalendarPolicy,
): BondTokenCatalog {
    const bondTokenExchange = repository.table<Record<string, readonly string[][]>>(
        "bond_token_exchange.json",
    )
    const products = new Map<number, BondTokenExchangeProduct>()
    for (const [equipmentIdText, rows] of Object.entries(bondTokenExchange)) {
        const equipmentId = parsePositiveSafeInteger(equipmentIdText, "equipment id")
        if (String(equipmentId) !== equipmentIdText) {
            throw new Error(`Bond token exchange equipment id is not canonical: ${equipmentIdText}`)
        }
        const entry = rows?.[0]
        if (rows.length !== 1 || entry === undefined || entry.length !== 4) {
            throw new Error(`Bond token exchange ${equipmentId} has an invalid product row`)
        }
        const product = Object.freeze({
            equipmentId,
            cost: parsePositiveSafeInteger(entry[0], `cost of ${equipmentId}`),
            stock: parseNonNegativeSafeInteger(entry[1], `stock of ${equipmentId}`),
            availableFromMs: parseCnPeriodTimestamp(entry[2], `period start of ${equipmentId}`, calendar),
            availableUntilMs: parseCnPeriodTimestamp(entry[3], `period end of ${equipmentId}`, calendar),
        })
        if (product.availableFromMs > product.availableUntilMs) {
            throw new Error(`Bond token exchange ${equipmentId} period is reversed`)
        }
        products.set(equipmentId, product)
    }
    const resolve = (
        equipmentId: number,
        nowMs: number,
    ): BondTokenExchangeProductResolution => {
        const product = products.get(equipmentId)
        if (product === undefined) return { ok: false, kind: "notFound" }
        if (!Number.isFinite(nowMs)
            || nowMs < product.availableFromMs
            || nowMs > product.availableUntilMs) {
            return { ok: false, kind: "outOfPeriod" }
        }
        return { ok: true, product }
    }
    const list = (nowMs: number): readonly BondTokenExchangeProduct[] => (
        !Number.isFinite(nowMs)
            ? []
            : [...products.values()].filter(product => (
                nowMs >= product.availableFromMs && nowMs <= product.availableUntilMs
            ))
    )
    return Object.freeze({ resolve, list })
}

export function getBondTokenExchangeCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
    calendar: GameCalendarPolicy = getGameCalendar(),
): BondTokenCatalog {
    let byOffset = catalogs.get(repository)
    if (byOffset === undefined) {
        byOffset = new Map<number, BondTokenCatalog>()
        catalogs.set(repository, byOffset)
    }
    const cached = byOffset.get(calendar.utcOffsetMinutes)
    if (cached !== undefined) return cached
    const catalog = buildBondTokenCatalog(repository, calendar)
    byOffset.set(calendar.utcOffsetMinutes, catalog)
    return catalog
}

export function resolveBondTokenExchangeProduct(
    equipmentId: number,
    nowMs: number,
): BondTokenExchangeProductResolution {
    return getBondTokenExchangeCatalog().resolve(equipmentId, nowMs)
}

export function listBondTokenExchangeProducts(nowMs: number): readonly BondTokenExchangeProduct[] {
    return getBondTokenExchangeCatalog().list(nowMs)
}
