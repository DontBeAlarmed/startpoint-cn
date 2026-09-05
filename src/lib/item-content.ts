import { deepFreeze } from "../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import type { ItemSaleEntry } from "./types"

export interface StaminaItemEffectEntry {
    readonly effectKind: 2 | 3
    readonly effectValue: number
}

export interface CultivatePackEffectEntry {
    readonly effectKind: 22
    readonly effectValue: 0
    readonly selectRewards: readonly {
        readonly itemId: number
        readonly amount: number
    }[]
}

export type ItemEffectEntry = StaminaItemEffectEntry | CultivatePackEffectEntry

export interface ItemContentCatalog {
    readonly effects: Readonly<Record<string, ItemEffectEntry>>
    readonly ids: readonly number[]
    readonly lookup: Readonly<Record<string, string>>
    readonly sale: Readonly<Record<string, ItemSaleEntry>>
}

const catalogs = new WeakMap<ReadonlyContentRepository, ItemContentCatalog>()

export function buildItemContentCatalog(
    repository: ReadonlyContentRepository,
): ItemContentCatalog {
    return deepFreeze({
        effects: repository.table("item_data.json"),
        ids: repository.table("item_ids.json"),
        lookup: repository.table("item_lookup.json"),
        sale: repository.table("item_sale.json"),
    })
}

export function getItemContentCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): ItemContentCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildItemContentCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}

export function getItemEffectSync(id: number | string): ItemEffectEntry | null {
    return getItemContentCatalog().effects[String(id)] ?? null
}

export function getItemIdsSync(): readonly number[] {
    return getItemContentCatalog().ids
}

export function getItemLookupSync(): Readonly<Record<string, string>> {
    return getItemContentCatalog().lookup
}

export function getItemSaleSync(id: number | string): ItemSaleEntry | null {
    return getItemContentCatalog().sale[String(id)] ?? null
}
