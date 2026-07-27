import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getServerDate } from "../utils"
import { getItemLookupSync } from "./assets"
import type { EventShopItems } from "./types"

interface GenerationWindow {
    id: number
    from: number
    until: number
}

let cachedEventItemShop: EventShopItems | null = null
let cachedItemLookup: Readonly<Record<string, string>> | null = null
let cachedFamilyByName = new Map<string, GenerationWindow[]>()

function parseShopDate(value: string | null | undefined, fallback: number): number {
    if (!value) return fallback
    const time = new Date(value.replace(" ", "T") + "Z").getTime()
    return Number.isNaN(time) ? fallback : time
}

function buildFamilies(
    eventItemShop: EventShopItems,
    lookup: Readonly<Record<string, string>>,
): Map<string, GenerationWindow[]> {
    const windowsByName = new Map<string, Map<string, GenerationWindow>>()
    const familyByName = new Map<string, GenerationWindow[]>()

    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk)
            return
        }
        if (!node || typeof node !== "object") return

        const value = node as Record<string, unknown>
        if (Array.isArray(value.costs)) {
            const from = parseShopDate(value.availableFrom as string | undefined, -Infinity)
            const until = parseShopDate(value.availableUntil as string | undefined, Infinity)
            for (const cost of value.costs as { id?: number }[]) {
                if (typeof cost?.id !== "number") continue
                const name = lookup[String(cost.id)]
                if (!name) continue
                const windows = windowsByName.get(name) ?? new Map<string, GenerationWindow>()
                windows.set(`${cost.id}:${from}:${until}`, { id: cost.id, from, until })
                windowsByName.set(name, windows)
            }
        }
        Object.values(value).forEach(walk)
    }
    walk(eventItemShop)

    for (const [name, windows] of windowsByName) {
        const values = [...windows.values()]
        if (new Set(values.map(value => value.id)).size >= 2) {
            familyByName.set(name, values)
        }
    }
    return familyByName
}

function getFamilyByName(): Map<string, GenerationWindow[]> {
    const eventItemShop = getContentSnapshot().repository.table<EventShopItems>(
        "event_item_shop.json",
    )
    const itemLookup = getItemLookupSync()
    if (eventItemShop !== cachedEventItemShop || itemLookup !== cachedItemLookup) {
        cachedEventItemShop = eventItemShop
        cachedItemLookup = itemLookup
        cachedFamilyByName = buildFamilies(eventItemShop, itemLookup)
    }
    return cachedFamilyByName
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
