import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"

export type StarCrumbExchangeKind = "character" | "item" | "equipment"

export interface StarCrumbExchangeProduct {
    readonly exchangeId: number
    readonly kind: StarCrumbExchangeKind
    readonly targetId: number
    readonly rarity: 4 | 5
    readonly cost: number
}

interface StarCrumbCatalog {
    readonly products: ReadonlyMap<number, Omit<StarCrumbExchangeProduct, "cost">>
    readonly costRows: Readonly<Record<string, readonly string[][]>>
}

const KIND_BY_RAW: Readonly<Record<string, StarCrumbExchangeKind>> = {
    "0": "character",
    "1": "item",
    "2": "equipment",
}

const catalogs = new WeakMap<ReadonlyContentRepository, StarCrumbCatalog>()

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Star Crumb exchange ${subject} is invalid: ${value}`)
    }
    return parsed
}

function buildStarCrumbCatalog(repository: ReadonlyContentRepository): StarCrumbCatalog {
    const starCrumbExchange = repository.table<Record<string, readonly string[][]>>(
        "star_crumb_exchange.json",
    )
    const costRows = repository.table<Record<string, readonly string[][]>>(
        "star_crumb_exchange_cost.json",
    )
    const products = new Map<number, Omit<StarCrumbExchangeProduct, "cost">>()
    for (const [exchangeIdText, rows] of Object.entries(starCrumbExchange)) {
        const exchangeId = parsePositiveInteger(exchangeIdText, "exchange id")
        const entry = rows?.[0]
        if (entry === undefined) {
            throw new Error(`Star Crumb exchange ${exchangeId} has no product row`)
        }
        const kind = KIND_BY_RAW[entry[0]]
        if (kind === undefined) {
            throw new Error(`Star Crumb exchange ${exchangeId} has unsupported kind ${entry[0]}`)
        }
        const rarity = Number(entry[8])
        if (rarity !== 4 && rarity !== 5) {
            throw new Error(`Star Crumb exchange ${exchangeId} has unsupported rarity ${entry[8]}`)
        }
        products.set(exchangeId, {
            exchangeId,
            kind,
            targetId: parsePositiveInteger(entry[1], `target id of ${exchangeId}`),
            rarity,
        })
    }
    return { products, costRows }
}

export function getStarCrumbExchangeCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): StarCrumbCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildStarCrumbCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}

export type StarCrumbExchangeProductResolution =
    | { readonly ok: true; readonly product: StarCrumbExchangeProduct }
    | { readonly ok: false; readonly kind: "notFound" }
    | { readonly ok: false; readonly kind: "noCost"; readonly rawKind: number }
    | { readonly ok: false; readonly kind: "invalidCost"; readonly rawKind: number; readonly rarity: 4 | 5 }

export function resolveStarCrumbExchangeProduct(
    exchangeId: number,
): StarCrumbExchangeProductResolution {
    const catalog = getStarCrumbExchangeCatalog()
    const product = catalog.products.get(exchangeId)
    if (product === undefined) return { ok: false, kind: "notFound" }
    const rawKind = product.kind === "character" ? 0 : product.kind === "item" ? 1 : 2
    const costEntry = catalog.costRows[String(rawKind)]
    if (costEntry === undefined || costEntry[0] === undefined) {
        return { ok: false, kind: "noCost", rawKind }
    }
    const cost = Number(costEntry[0][product.rarity === 5 ? 1 : 0])
    if (isNaN(cost) || cost <= 0) {
        return { ok: false, kind: "invalidCost", rawKind, rarity: product.rarity }
    }
    return { ok: true, product: { ...product, cost } }
}
