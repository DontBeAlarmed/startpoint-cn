import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"

export interface BondTokenExchangeProduct {
    readonly equipmentId: number
    readonly cost: number
    readonly stock: number
    readonly availableFromMs: number
    readonly availableUntilMs: number
}

const catalogs = new WeakMap<ReadonlyContentRepository, BondTokenCatalog>()

// CDN period 字符串按 CN 时区（UTC+8）解释，与 shop period 私服口径一致；客户端按 JST
// 解析，真实数据 period=2019-01-01→2200-02-05 两种口径下均常开，差异不可达。
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

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

function parseCnPeriodTimestamp(value: string, subject: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) {
        throw new Error(`Bond token exchange ${subject} is invalid: ${value}`)
    }
    const parts = [match[1], match[2], match[3], match[4], match[5], match[6]].map(Number)
    const [year, month, day, hour, minute, second] = parts
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second)
    const normalized = new Date(utcMs)
    const normalizedParts = [
        normalized.getUTCFullYear(),
        normalized.getUTCMonth() + 1,
        normalized.getUTCDate(),
        normalized.getUTCHours(),
        normalized.getUTCMinutes(),
        normalized.getUTCSeconds(),
    ]
    if (
        !Number.isFinite(utcMs)
        || parts.some((part, index) => part !== normalizedParts[index])
    ) {
        throw new Error(`Bond token exchange ${subject} is invalid: ${value}`)
    }
    return utcMs - CN_OFFSET_MS
}

function buildBondTokenCatalog(repository: ReadonlyContentRepository): BondTokenCatalog {
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
            availableFromMs: parseCnPeriodTimestamp(entry[2], `period start of ${equipmentId}`),
            availableUntilMs: parseCnPeriodTimestamp(entry[3], `period end of ${equipmentId}`),
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
): BondTokenCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildBondTokenCatalog(repository)
    catalogs.set(repository, catalog)
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
