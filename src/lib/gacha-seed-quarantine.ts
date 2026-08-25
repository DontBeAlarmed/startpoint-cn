import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, join } from "path"

import { resolveRuntimeDataPaths } from "../runtime/data-paths"
import { getRealNowMs } from "../runtime/time/game-time"

const SCHEMA_VERSION = 1
const DEFAULT_RECENT_TTL_MS = 10 * 60 * 1000
const MAX_SEED = 2_147_483_647
const MOVIE_IDS = new Set(["normal", "normal_guarantee", "fes", "fes_guarantee"])

interface RecentSeed {
    rarity: number
    sentAt: number
}

interface QuarantineSnapshot {
    schemaVersion: 1
    movies: Record<string, number[]>
}

export interface GachaSeedQuarantineOptions {
    stateFile?: string
    now?: () => number
    recentTtlMs?: number
    logger?: Pick<Console, "warn">
    writeSnapshot?: (stateFile: string, snapshot: string) => void
}

function requireMovieId(movieId: string): void {
    if (!MOVIE_IDS.has(movieId)) throw new Error(`Invalid gacha quarantine movie: ${movieId}`)
}

function requireSeed(seed: number): void {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
        throw new Error(`Invalid gacha quarantine seed: ${seed}`)
    }
}

function parseSnapshot(source: string): QuarantineSnapshot {
    let value: unknown
    try {
        value = JSON.parse(source)
    } catch {
        throw new Error("Invalid gacha seed quarantine JSON")
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid gacha seed quarantine snapshot")
    }
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== SCHEMA_VERSION
        || record.movies === null
        || typeof record.movies !== "object"
        || Array.isArray(record.movies)) {
        throw new Error("Invalid gacha seed quarantine snapshot")
    }

    const movies: Record<string, number[]> = {}
    for (const [movieId, rawSeeds] of Object.entries(record.movies as Record<string, unknown>)) {
        requireMovieId(movieId)
        if (!Array.isArray(rawSeeds)) throw new Error("Invalid gacha seed quarantine movie pool")
        const seen = new Set<number>()
        movies[movieId] = rawSeeds.map(rawSeed => {
            requireSeed(rawSeed as number)
            const seed = rawSeed as number
            if (seen.has(seed)) throw new Error("Invalid duplicate gacha seed quarantine entry")
            seen.add(seed)
            return seed
        })
    }
    return { schemaVersion: SCHEMA_VERSION, movies }
}

export class GachaSeedQuarantine {
    private readonly stateFile: string
    private readonly now: () => number
    private readonly recentTtlMs: number
    private readonly writeSnapshot: (stateFile: string, snapshot: string) => void
    private readonly quarantined = new Map<string, Set<number>>()
    private readonly recent = new Map<string, RecentSeed>()

    constructor(options: GachaSeedQuarantineOptions = {}) {
        this.stateFile = options.stateFile
            ?? join(resolveRuntimeDataPaths().seedStateDir, "quarantine.json")
        this.now = options.now ?? getRealNowMs
        this.recentTtlMs = options.recentTtlMs ?? DEFAULT_RECENT_TTL_MS
        this.writeSnapshot = options.writeSnapshot ?? ((stateFile, snapshot) => {
            mkdirSync(dirname(stateFile), { recursive: true })
            const temporaryFile = `${stateFile}.${process.pid}.tmp`
            writeFileSync(temporaryFile, snapshot, "utf8")
            renameSync(temporaryFile, stateFile)
        })
        if (!Number.isSafeInteger(this.recentTtlMs) || this.recentTtlMs <= 0) {
            throw new Error("Invalid gacha seed quarantine recent TTL")
        }
        if (existsSync(this.stateFile)) {
            try {
                const snapshot = parseSnapshot(readFileSync(this.stateFile, "utf8"))
                for (const [movieId, seeds] of Object.entries(snapshot.movies)) {
                    this.quarantined.set(movieId, new Set(seeds))
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const logger = options.logger ?? console
                logger.warn(
                    `[GACHA-SEED] Ignoring invalid quarantine state: ${message}`,
                )
            }
        }
    }

    private key(movieId: string, seed: number): string {
        return `${movieId}:${seed}`
    }

    private pruneRecent(now: number): void {
        const expiresBefore = now - this.recentTtlMs
        for (const [key, entry] of this.recent) {
            if (entry.sentAt <= expiresBefore) this.recent.delete(key)
        }
    }

    private snapshot(): QuarantineSnapshot {
        const movies: Record<string, number[]> = {}
        for (const movieId of [...this.quarantined.keys()].sort()) {
            const seeds = [...this.quarantined.get(movieId)!].sort((left, right) => left - right)
            if (seeds.length > 0) movies[movieId] = seeds
        }
        return { schemaVersion: SCHEMA_VERSION, movies }
    }

    private persist(): void {
        this.writeSnapshot(this.stateFile, JSON.stringify(this.snapshot()))
    }

    markSent(movieId: string, seed: number, rarity: number): void {
        requireMovieId(movieId)
        requireSeed(seed)
        if (!Number.isInteger(rarity) || rarity < 3 || rarity > 5) {
            throw new Error(`Invalid recently sent gacha rarity: ${rarity}`)
        }
        const now = this.now()
        this.pruneRecent(now)
        this.recent.set(this.key(movieId, seed), { rarity, sentAt: now })
    }

    quarantineIfRecentlySent(movieId: string, seed: number): boolean {
        requireMovieId(movieId)
        requireSeed(seed)
        const now = this.now()
        this.pruneRecent(now)
        const key = this.key(movieId, seed)
        const recent = this.recent.get(key)
        if (recent === undefined) return false
        this.recent.delete(key)

        const movieSeeds = this.quarantined.get(movieId) ?? new Set<number>()
        if (movieSeeds.has(seed)) return false
        movieSeeds.add(seed)
        this.quarantined.set(movieId, movieSeeds)
        try {
            this.persist()
        } catch (error) {
            movieSeeds.delete(seed)
            if (movieSeeds.size === 0) this.quarantined.delete(movieId)
            this.recent.set(key, recent)
            throw error
        }
        return true
    }

    isQuarantined(movieId: string, seed: number): boolean {
        return this.quarantined.get(movieId)?.has(seed) ?? false
    }

    stats(): { total: number; movies: Record<string, number> } {
        const movies: Record<string, number> = {}
        let total = 0
        for (const movieId of [...this.quarantined.keys()].sort()) {
            const count = this.quarantined.get(movieId)!.size
            if (count > 0) movies[movieId] = count
            total += count
        }
        return { total, movies }
    }

    samples(limit: number): Record<string, number[]> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Invalid gacha quarantine sample limit")
        }
        return Object.fromEntries(Object.entries(this.snapshot().movies).map(([movieId, seeds]) => (
            [movieId, seeds.slice(0, limit)]
        )))
    }
}

let defaultQuarantine: GachaSeedQuarantine | null = null

export function getDefaultGachaSeedQuarantine(): GachaSeedQuarantine {
    if (defaultQuarantine === null) defaultQuarantine = new GachaSeedQuarantine()
    return defaultQuarantine
}
