import { getServerDate } from "../utils"
import { getItemLookupSync } from "./item-content"
import { getShopCatalog, type ShopCatalog } from "./shop"

interface GenerationWindow {
    id: number
    from: number
    until: number
}

interface EventCurrencyFamilies {
    readonly itemLookup: Readonly<Record<string, string>>
    readonly familyByName: ReadonlyMap<string, readonly GenerationWindow[]>
}

const familiesByCatalog = new WeakMap<ShopCatalog, EventCurrencyFamilies>()

function buildFamilies(
    catalog: ShopCatalog,
    lookup: Readonly<Record<string, string>>,
): Map<string, GenerationWindow[]> {
    const windowsByName = new Map<string, Map<string, GenerationWindow>>()
    const familyByName = new Map<string, GenerationWindow[]>()

    for (const [itemIdText, sourceWindows] of Object.entries(
        catalog.eventCurrencyWindowsByItemId,
    )) {
        const itemId = Number(itemIdText)
        const name = lookup[itemIdText]
        if (!name) continue
        const windows = windowsByName.get(name) ?? new Map<string, GenerationWindow>()
        for (const window of sourceWindows) {
            windows.set(
                `${itemId}:${window.fromMs}:${window.untilMs}`,
                { id: itemId, from: window.fromMs, until: window.untilMs },
            )
        }
        windowsByName.set(name, windows)
    }

    for (const [name, windows] of windowsByName) {
        const values = [...windows.values()]
        if (new Set(values.map(value => value.id)).size >= 2) {
            familyByName.set(name, values)
        }
    }
    return familyByName
}

function getFamilyByName(): ReadonlyMap<string, readonly GenerationWindow[]> {
    const catalog = getShopCatalog()
    const itemLookup = getItemLookupSync()
    const cached = familiesByCatalog.get(catalog)
    if (cached !== undefined && cached.itemLookup === itemLookup) return cached.familyByName
    const familyByName = buildFamilies(catalog, itemLookup)
    familiesByCatalog.set(catalog, { itemLookup, familyByName })
    return familyByName
}

export function resolveEventCurrencyId(itemId: number, at: Date = getServerDate()): number {
    const name = getItemLookupSync()[String(itemId)]
    const family = name ? getFamilyByName().get(name) : undefined
    if (!family) return itemId

    const time = at.getTime()
    const active = family
        .filter(window => time >= window.from && time <= window.until)
        .sort((left, right) => right.from - left.from || left.until - right.until)
    return active[0]?.id ?? itemId
}
