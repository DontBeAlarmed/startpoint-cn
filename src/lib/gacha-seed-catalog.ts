import { createHash, randomInt as cryptoRandomInt } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"

import { getDefaultGachaSeedQuarantine } from "./gacha-seed-quarantine"

type SeedPool = Record<string, Record<string, number[]>>

interface SeedCatalogManifest {
    schemaVersion: number
    clientVersion: string
    cdnVersion: string
    configDigest: string
    predictorDigest: string
    seedRange: { start: number; end: number }
    seedCountPerMovie: number
    totalSeedCount: number
    movieIds: string[]
    rarityCounts: Record<string, { "3": number; "4": number; "5": number }>
    poolDigests: Record<string, string>
}

export interface GachaSeedCatalogStatus {
    schemaVersion: number
    clientVersion: string
    cdnVersion: string
    seedRange: { start: number; end: number }
    totalSeedCount: number
    movies: Array<{
        movieId: string
        rarityCounts: { "3": number; "4": number; "5": number }
    }>
}

export interface GachaSeedCatalogOptions {
    catalogDir?: string
    readFile?: (filePath: string) => string
    randomInt?: (maxExclusive: number) => number
    isQuarantined?: (movieId: string, seed: number) => boolean
}

const DEFAULT_CATALOG_DIR = join(__dirname, "..", "..", "assets", "gacha-seed-catalog")
const EXPECTED_CLIENT_VERSION = "1.8.1"
const EXPECTED_CDN_VERSION = "1.4.54"
const OFFICIAL_MOVIE_IDS = ["fes", "fes_guarantee", "normal", "normal_guarantee"] as const
const MOVIE_ID_PATTERN = /^[a-z][a-z0-9_]*$/
const MAX_SEED = 2_147_483_647
const SHA256_PATTERN = /^[a-f0-9]{64}$/

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
    const seedRange = requireRecord(manifest.seedRange, "seed range")
    if (manifest.clientVersion !== EXPECTED_CLIENT_VERSION) {
        throw new Error("Unsupported gacha seed catalog client version")
    }
    if (manifest.cdnVersion !== EXPECTED_CDN_VERSION) {
        throw new Error("Unsupported gacha seed catalog CDN version")
    }
    if (!Number.isSafeInteger(seedRange.start)
        || !Number.isSafeInteger(seedRange.end)
        || (seedRange.start as number) < 0
        || (seedRange.end as number) > MAX_SEED
        || (seedRange.start as number) > (seedRange.end as number)) {
        throw new Error("Invalid gacha seed catalog seed range")
    }
    if (!Number.isSafeInteger(manifest.seedCountPerMovie)
        || !Number.isSafeInteger(manifest.totalSeedCount)
        || (manifest.totalSeedCount as number) < 0) {
        throw new Error("Invalid gacha seed catalog metadata")
    }
    if (typeof manifest.configDigest !== "string" || !SHA256_PATTERN.test(manifest.configDigest)
        || typeof manifest.predictorDigest !== "string" || !SHA256_PATTERN.test(manifest.predictorDigest)) {
        throw new Error("Invalid gacha seed catalog digest metadata")
    }
    const movieIds = manifest.movieIds.map(movieId => {
        if (typeof movieId !== "string" || !MOVIE_ID_PATTERN.test(movieId)) {
            throw new Error("Invalid gacha seed catalog movie id")
        }
        return movieId
    })
    if (movieIds.length !== OFFICIAL_MOVIE_IDS.length
        || new Set(movieIds).size !== movieIds.length
        || OFFICIAL_MOVIE_IDS.some(movieId => !movieIds.includes(movieId))) {
        throw new Error("Invalid gacha seed catalog movie list")
    }
    const expectedSeedCount = (seedRange.end as number) - (seedRange.start as number) + 1
    if (manifest.seedCountPerMovie !== expectedSeedCount) {
        throw new Error("Invalid gacha seed catalog seed count per movie")
    }
    if (manifest.totalSeedCount !== expectedSeedCount * OFFICIAL_MOVIE_IDS.length) {
        throw new Error("Invalid gacha seed catalog total seed count")
    }
    const poolDigests = requireRecord(manifest.poolDigests, "pool digests")
    const rarityCountsSource = requireRecord(manifest.rarityCounts, "rarity counts")
    const rarityCounts = Object.fromEntries(movieIds.map(movieId => {
        const counts = requireRecord(rarityCountsSource[movieId], `${movieId} rarity counts`)
        const values = [counts["3"], counts["4"], counts["5"]]
        if (values.some(count => !Number.isSafeInteger(count) || (count as number) < 0)
            || values.reduce<number>((sum, count) => sum + (count as number), 0) !== expectedSeedCount) {
            throw new Error(`Invalid gacha seed catalog rarity counts for ${movieId}`)
        }
        return [movieId, {
            "3": values[0] as number,
            "4": values[1] as number,
            "5": values[2] as number,
        }]
    }))
    return {
        schemaVersion: 1,
        clientVersion: EXPECTED_CLIENT_VERSION,
        cdnVersion: EXPECTED_CDN_VERSION,
        configDigest: manifest.configDigest,
        predictorDigest: manifest.predictorDigest,
        seedRange: { start: seedRange.start as number, end: seedRange.end as number },
        seedCountPerMovie: manifest.seedCountPerMovie as number,
        totalSeedCount: manifest.totalSeedCount as number,
        movieIds,
        rarityCounts,
        poolDigests: Object.fromEntries(movieIds.map(movieId => {
            const digest = poolDigests[movieId]
            if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
                throw new Error(`Invalid gacha seed catalog digest for ${movieId}`)
            }
            return [movieId, digest]
        })),
    }
}

function parsePool(
    value: unknown,
    movieId: string,
    seedRange: { start: number; end: number },
): SeedPool {
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
            if (seed < seedRange.start || seed > seedRange.end) {
                throw new Error(`Gacha seed ${seed} in ${movieId} is outside manifest range`)
            }
            if (seen.has(seed)) throw new Error(`Duplicate gacha seed ${seed} in ${movieId}`)
            seen.add(seed)
            return seed
        }) }
    }
    for (let seed = seedRange.start; seed <= seedRange.end; seed += 1) {
        if (!seen.has(seed)) throw new Error(`Missing seed ${seed} in gacha movie ${movieId}`)
    }
    return pool
}

export class GachaSeedCatalog {
    private readonly pools = new Map<string, SeedPool>()
    private readonly manifest: SeedCatalogManifest
    private readonly chooseIndex: (maxExclusive: number) => number
    private readonly isQuarantined: (movieId: string, seed: number) => boolean

    constructor(options: GachaSeedCatalogOptions = {}) {
        const catalogDir = options.catalogDir ?? DEFAULT_CATALOG_DIR
        const readFile = options.readFile ?? (filePath => readFileSync(filePath, "utf8"))
        this.chooseIndex = options.randomInt ?? (maxExclusive => cryptoRandomInt(maxExclusive))
        this.isQuarantined = options.isQuarantined ?? (() => false)

        const manifest = parseManifest(parseJson(
            readFile(join(catalogDir, "manifest.json")),
            "manifest.json",
        ))
        this.manifest = manifest
        let totalSeedCount = 0
        for (const movieId of manifest.movieIds) {
            const pool = parsePool(
                parseJson(readFile(join(catalogDir, `${movieId}.json`)), `${movieId}.json`),
                movieId,
                manifest.seedRange,
            )
            if (digestPool(pool) !== manifest.poolDigests[movieId]) {
                throw new Error(`Gacha seed catalog digest mismatch for ${movieId}`)
            }
            this.pools.set(movieId, pool)
            const actualRarityCounts = {
                "3": pool["3"]["0"].length,
                "4": pool["2"]["0"].length,
                "5": pool["1"]["0"].length,
            }
            if (JSON.stringify(actualRarityCounts) !== JSON.stringify(manifest.rarityCounts[movieId])) {
                throw new Error(`Gacha seed catalog rarity count mismatch for ${movieId}`)
            }
            totalSeedCount += Object.values(actualRarityCounts).reduce((sum, count) => sum + count, 0)
        }
        if (totalSeedCount !== manifest.totalSeedCount) {
            throw new Error("Gacha seed catalog total count mismatch")
        }
    }

    select(movieId: string, rarity: number, usedSeeds: Set<number>): number {
        const pool = this.pools.get(movieId)
        if (!pool) throw new Error(`Unknown gacha movie: ${movieId}`)
        if (!Number.isInteger(rarity) || rarity < 3 || rarity > 5) {
            throw new Error(`Invalid gacha rarity: ${rarity}`)
        }

        const rarityKey = String(6 - rarity)
        const available = pool[rarityKey]["0"].filter(
            seed => !usedSeeds.has(seed) && !this.isQuarantined(movieId, seed),
        )
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

    status(): GachaSeedCatalogStatus {
        return {
            schemaVersion: this.manifest.schemaVersion,
            clientVersion: this.manifest.clientVersion,
            cdnVersion: this.manifest.cdnVersion,
            seedRange: { ...this.manifest.seedRange },
            totalSeedCount: this.manifest.totalSeedCount,
            movies: this.manifest.movieIds.map(movieId => {
                const pool = this.pools.get(movieId)!
                return {
                    movieId,
                    rarityCounts: {
                        "3": pool["3"]["0"].length,
                        "4": pool["2"]["0"].length,
                        "5": pool["1"]["0"].length,
                    },
                }
            }),
        }
    }
}

let defaultCatalog: GachaSeedCatalog | null = null

export function getDefaultGachaSeedCatalog(): GachaSeedCatalog {
    if (defaultCatalog === null) {
        const quarantine = getDefaultGachaSeedQuarantine()
        defaultCatalog = new GachaSeedCatalog({
            isQuarantined: (movieId, seed) => quarantine.isQuarantined(movieId, seed),
        })
    }
    return defaultCatalog
}
