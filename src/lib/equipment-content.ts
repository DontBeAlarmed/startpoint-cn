import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import { validateEquipmentContentTables } from "../content/validation/item-equipment-output"
import type { EquipmentCraftEntry, EquipmentDissolveEntry } from "./types"

const MIN_EQUIPMENT_RARITY = 1
const MAX_EQUIPMENT_RARITY = 5

export interface EquipmentLookupEntry {
    readonly name: string
    readonly rarity: string
    readonly category: string
}

export interface EquipmentContentCatalog {
    readonly craftByRarity: Readonly<Record<string, EquipmentCraftEntry>>
    readonly dissolveById: Readonly<Record<string, EquipmentDissolveEntry>>
    readonly ids: readonly number[]
    readonly lookup: Readonly<Record<string, EquipmentLookupEntry>>
}

const catalogs = new WeakMap<ReadonlyContentRepository, EquipmentContentCatalog>()

export function buildEquipmentContentCatalog(
    repository: ReadonlyContentRepository,
): EquipmentContentCatalog {
    return validateEquipmentContentTables({
        craftByRarity: repository.table("equipment_craft.json"),
        dissolveById: repository.table("equipment_dissolve.json"),
        ids: repository.table("equipment_ids.json"),
        lookup: repository.table("equipment_lookup.json"),
    }) as EquipmentContentCatalog
}

export function getEquipmentContentCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): EquipmentContentCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildEquipmentContentCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}

export function getEquipmentDissolveSync(
    id: number | string,
): EquipmentDissolveEntry | null {
    return getEquipmentContentCatalog().dissolveById[String(id)] ?? null
}

export function getEquipmentIdsSync(): readonly number[] {
    return getEquipmentContentCatalog().ids
}

export function getEquipmentLookupSync(): Readonly<Record<string, EquipmentLookupEntry>> {
    return getEquipmentContentCatalog().lookup
}

export function getEquipmentRaritySync(
    id: number | string,
    repository?: ReadonlyContentRepository,
): number | null {
    const lookup = getEquipmentContentCatalog(repository ?? getContentSnapshot().repository)
        .lookup[String(id)]
    if (lookup === undefined) return null
    return Number(lookup.rarity)
}

export function getEquipmentCraftSync(rarity: number): EquipmentCraftEntry | null {
    if (!Number.isInteger(rarity)
        || rarity < MIN_EQUIPMENT_RARITY
        || rarity > MAX_EQUIPMENT_RARITY) {
        return null
    }
    return getEquipmentContentCatalog().craftByRarity[String(rarity)] ?? null
}
