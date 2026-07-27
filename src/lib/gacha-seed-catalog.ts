import { createHash, randomInt as cryptoRandomInt } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"

type SeedPool = Record<string, Record<string, number[]>>

interface SeedCatalogManifest {
    schemaVersion: number
    movieIds: string[]
    poolDigests: Record<string, string>
}

export interface GachaSeedCatalogOptions {
    catalogDir?: string
    readFile?: (filePath: string) => string
    randomInt?: (maxExclusive: number) => number
}

const DEFAULT_CATALOG_DIR = join(__dirname, "..", "..", "assets", "gacha-seed-catalog")
const MOVIE_ID_PATTERN = /^[a-z][a-z0-9_]*$/
const MAX_SEED = 2_147_483_647

export function reserveUniquePlaceholderSeed(preferredSeed: number, usedSeeds: Set<number>): number {
    if (!Number.isSafeInteger(preferredSeed) || preferredSeed < 0 || preferredSeed > MAX_SEED) {
        throw new Error(`Invalid placeholder gacha seed: ${preferredSeed}`)
    }
    let seed = preferredSeed
    while (usedSeeds.has(seed)) {
        seed = seed === MAX_SEED ? 0 : seed + 1
        if (seed === preferredSeed) throw new Error("No available placeholder gacha seed")
    }
    usedSeeds.add(seed)
    return seed
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value)
    } catch {
        throw new Error(`Invalid gacha seed catalog JSON: ${label}`)
    }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid gacha seed catalog ${label}`)
    }
    return value as Record<string, unknown>
}

function digestPool(pool: SeedPool): string {
    return createHash("sha256").update(JSON.stringify(pool)).digest("hex")
}

function parseManifest(value: unknown): SeedCatalogManifest {
    const manifest = requireRecord(value, "manifest")
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.movieIds)) {
        throw new Error("Unsupported gacha seed catalog manifest")
    }
    const movieIds = manifest.movieIds.map(movieId => {
        if (typeof movieId !== "string" || !MOVIE_ID_PATTERN.test(movieId)) {
            throw new Error("Invalid gacha seed catalog movie id")
        }
        return movieId
    })
    if (movieIds.length === 0 || new Set(movieIds).size !== movieIds.length) {
        throw new Error("Invalid gacha seed catalog movie list")
    }
    const poolDigests = requireRecord(manifest.poolDigests, "pool digests")
    return {
        schemaVersion: 1,
        movieIds,
        poolDigests: Object.fromEntries(movieIds.map(movieId => {
            const digest = poolDigests[movieId]
            if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
                throw new Error(`Invalid gacha seed catalog digest for ${movieId}`)
            }
            return [movieId, digest]
        })),
    }
}

function parsePool(value: unknown, movieId: string): SeedPool {
    const source = requireRecord(value, `${movieId} pool`)
    const pool: SeedPool = {}
    const seen = new Set<number>()
    for (const rarityKey of ["1", "2", "3"]) {
        const rarity = requireRecord(source[rarityKey], `${movieId} rarity ${rarityKey}`)
        const seeds = rarity["0"]
        if (!Array.isArray(seeds)) throw new Error(`Invalid gacha seed catalog bucket ${movieId}/${rarityKey}`)
        pool[rarityKey] = { "0": seeds.map(seed => {
            if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
                throw new Error(`Invalid gacha seed ${String(seed)} in ${movieId}`)
            }
            if (seen.has(seed)) throw new Error(`Duplicate gacha seed ${seed} in ${movieId}`)
            seen.add(seed)
            return seed
        }) }
    }
    return pool
}

export class GachaSeedCatalog {
    private readonly pools = new Map<string, SeedPool>()
    private readonly chooseIndex: (maxExclusive: number) => number

    constructor(options: GachaSeedCatalogOptions = {}) {
        const catalogDir = options.catalogDir ?? DEFAULT_CATALOG_DIR
        const readFile = options.readFile ?? (filePath => readFileSync(filePath, "utf8"))
        this.chooseIndex = options.randomInt ?? (maxExclusive => cryptoRandomInt(maxExclusive))

        const manifest = parseManifest(parseJson(
            readFile(join(catalogDir, "manifest.json")),
            "manifest.json",
        ))
        for (const movieId of manifest.movieIds) {
            const pool = parsePool(
                parseJson(readFile(join(catalogDir, `${movieId}.json`)), `${movieId}.json`),
                movieId,
            )
            if (digestPool(pool) !== manifest.poolDigests[movieId]) {
                throw new Error(`Gacha seed catalog digest mismatch for ${movieId}`)
            }
            this.pools.set(movieId, pool)
        }
    }

    select(movieId: string, rarity: number, usedSeeds: Set<number>): number {
        const pool = this.pools.get(movieId)
        if (!pool) throw new Error(`Unknown gacha movie: ${movieId}`)
        if (!Number.isInteger(rarity) || rarity < 3 || rarity > 5) {
            throw new Error(`Invalid gacha rarity: ${rarity}`)
        }

        const rarityKey = String(6 - rarity)
        const available = pool[rarityKey]["0"].filter(seed => !usedSeeds.has(seed))
        if (available.length === 0) {
            throw new Error(`No available gacha seed for ${movieId} rarity ${rarity}`)
        }
        const index = this.chooseIndex(available.length)
        if (!Number.isInteger(index) || index < 0 || index >= available.length) {
            throw new Error("Gacha seed random index is outside the available pool")
        }
        const seed = available[index]
        usedSeeds.add(seed)
        return seed
    }
}

let defaultCatalog: GachaSeedCatalog | null = null

export function getDefaultGachaSeedCatalog(): GachaSeedCatalog {
    if (defaultCatalog === null) defaultCatalog = new GachaSeedCatalog()
    return defaultCatalog
}
