import { deepFreeze } from "../content/deep-freeze"
import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import type { ExAbilities, ExBoostItem, ExBoostItems, ExStatus } from "./types"

export interface ExBoostAbilityDrawPools {
    readonly A: Record<number, number[]>
    readonly B: Record<number, number[]>
}

export interface ExBoostContentCatalog {
    readonly resolveMaterial: (itemId: number) => Readonly<ExBoostItem> | null
    readonly resolveStatusPool: (tier: number) => readonly number[] | null
    readonly createAbilityDrawPools: () => ExBoostAbilityDrawPools
}

const A_PREFIXES = ["atk_self_", "skilldamage_self_", "directdamage_self_",
    "abilitydamage_self_", "abilitydagame_self_", "atk_party_", "skilldamage_party_",
    "directdamage_party_", "abilitydamage_party_", "abilitydagame_party_",
    "powerflipdamage_", "hp_self_"]
const B_OVERRIDES = ["powerflipdamage_buffextend_"]

function positiveInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`Invalid EX Boost ${subject}.`)
    }
    return value as number
}

function canonicalId(value: string, subject: string): number {
    if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`Invalid EX Boost ${subject}.`)
    return positiveInteger(Number(value), subject)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function buildAbilityPools(abilities: ExAbilities): {
    A: Record<number, readonly number[]>
    B: Record<number, readonly number[]>
} {
    if (!isRecord(abilities)) throw new TypeError("Invalid EX Boost ability table.")
    const pools: { A: Record<number, number[]>; B: Record<number, number[]> } = {
        A: { 1: [], 2: [], 3: [] },
        B: { 1: [], 2: [], 3: [] },
    }
    for (const [idText, raw] of Object.entries(abilities)) {
        const id = canonicalId(idText, "ability id")
        if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
            throw new TypeError(`Invalid EX Boost ability ${id}.`)
        }
        const name = raw[0][0]
        if (typeof name !== "string" || !/_r[345]$/.test(name)) {
            throw new TypeError(`Invalid EX Boost ability ${id} name.`)
        }
        const rarity = name.endsWith("_r5") ? 3 : name.endsWith("_r4") ? 2 : 1
        const isBOverride = B_OVERRIDES.some(prefix => name.startsWith(prefix))
        const group = !isBOverride && A_PREFIXES.some(prefix => name.startsWith(prefix))
            ? "A"
            : "B"
        pools[group][rarity].push(id)
    }
    for (const group of ["A", "B"] as const) {
        for (const rarity of [1, 2, 3]) {
            if (pools[group][rarity].length === 0) {
                throw new TypeError(`EX Boost ${group}/${rarity} ability pool is empty.`)
            }
        }
    }
    return pools
}

export function buildExBoostContentCatalog(
    repository: ReadonlyContentRepository,
): ExBoostContentCatalog {
    const materials = repository.table<ExBoostItems>("ex_boost.json")
    const statuses = repository.table<ExStatus>("ex_status.json")
    const abilities = repository.table<ExAbilities>("ex_ability.json")
    if (!isRecord(materials) || !isRecord(statuses)) {
        throw new TypeError("Invalid EX Boost Content root.")
    }
    for (const [itemIdText, material] of Object.entries(materials)) {
        const itemId = canonicalId(itemIdText, "material id")
        if (!isRecord(material)
            || ![1, 2, 3].includes(material.tier as number)
            || !Number.isSafeInteger(material.count) || (material.count as number) <= 0
            || (material.element !== undefined
                && (!Number.isSafeInteger(material.element)
                    || (material.element as number) < 0 || (material.element as number) > 5))) {
            throw new TypeError(`Invalid EX Boost material ${itemId}.`)
        }
    }
    if (Object.keys(statuses).sort().join(",") !== "1,2,3") {
        throw new TypeError("Invalid EX Boost status tiers.")
    }
    for (const tier of [1, 2, 3]) {
        const pool = statuses[String(tier)]
        if (!Array.isArray(pool) || pool.length === 0
            || pool.some(statusId => !Number.isSafeInteger(statusId) || statusId <= 0)) {
            throw new TypeError(`Invalid EX Boost status tier ${tier}.`)
        }
    }
    const abilityPools = buildAbilityPools(abilities)
    return deepFreeze({
        resolveMaterial: (itemId: number) => materials[String(itemId)] ?? null,
        resolveStatusPool: (tier: number) => statuses[String(tier)] ?? null,
        createAbilityDrawPools: () => ({
            A: { 1: [...abilityPools.A[1]], 2: [...abilityPools.A[2]], 3: [...abilityPools.A[3]] },
            B: { 1: [...abilityPools.B[1]], 2: [...abilityPools.B[2]], 3: [...abilityPools.B[3]] },
        }),
    })
}

const catalogs = new WeakMap<ReadonlyContentRepository, ExBoostContentCatalog>()

export function getExBoostContentCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): ExBoostContentCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildExBoostContentCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}
