export const SEED_MOVIE_IDS = [
    "normal",
    "normal_guarantee",
    "fes",
    "fes_guarantee",
    "rarity_5_guarantee",
] as const;

export type SeedMovieId = typeof SEED_MOVIE_IDS[number];

// Generated CN animation corpora cover this contiguous range.
export const MIN_GACHA_TEST_SEED = 10_000_000;
export const MAX_GACHA_TEST_SEED = 10_399_999;
// Flash MT consumes a signed int32 seed; the HTTP integer compatibility layer
// also requires runtime integers to remain below 2^31.
export const MAX_RUNTIME_SEED = 0x7fffffff;

const SEED_TAGS = ['未测试', '热血躲避球', '普通躲避球', '冷血躲避球'] as const;
export type SerializedSeedTag = typeof SEED_TAGS[number];

export interface SerializedSeedPlayEntry {
    r: number;
    tag: SerializedSeedTag;
    play?: boolean;
}

export interface SeedRuntimeSnapshot {
    schemaVersion: 1;
    confirmed: Record<string, Record<string, number | null>>;
    pending: Record<string, Record<string, number | null>>;
    play: Record<string, Record<string, SerializedSeedPlayEntry>>;
    verified: Record<string, Record<string, number>>;
    config: { selectedMovieId: SeedMovieId };
    testSeeds: (number | null)[];
}

export class SeedInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SeedInputError";
    }
}

export function createSeedRecord<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    label: string,
): void {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) throw new Error(`${label} has unexpected key ${unexpected[0]}`);
}

export function validateMovieId(value: unknown): SeedMovieId {
    if (
        typeof value !== "string"
        || value.length === 0
        || value.length > 64
        || value !== value.trim()
        || !/^[a-z0-9_]+$/.test(value)
        || value === "__proto__"
        || value === "prototype"
        || value === "constructor"
        || !(SEED_MOVIE_IDS as readonly string[]).includes(value)
    ) {
        throw new SeedInputError(`Invalid seed movie id: ${String(value)}`);
    }
    return value as SeedMovieId;
}

export function validateRuntimeSeed(value: unknown): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < 0
        || value > MAX_RUNTIME_SEED
    ) {
        throw new SeedInputError(`Invalid seed value: ${String(value)}`);
    }
    return value;
}

export function validateTestSeed(value: unknown): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < MIN_GACHA_TEST_SEED
        || value > MAX_GACHA_TEST_SEED
    ) {
        throw new SeedInputError(`Invalid test seed: ${String(value)}`);
    }
    return value;
}

export function validateRarityIndex(value: unknown, label = "rarity"): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) {
        throw new SeedInputError(`Invalid ${label}: ${String(value)}`);
    }
    return value as number;
}

export function validateSeedTag(value: unknown): SerializedSeedTag {
    if (!(SEED_TAGS as readonly unknown[]).includes(value)) {
        throw new SeedInputError(`Invalid seed tag: ${String(value)}`);
    }
    return value as SerializedSeedTag;
}

function validateSeedKey(value: string, label: string): number {
    let seed: number;
    try {
        seed = validateRuntimeSeed(Number(value));
    } catch {
        throw new Error(`${label} ${value} must be a canonical seed key`);
    }
    if (value !== String(seed)) {
        throw new Error(`${label} ${value} must be a canonical seed key`);
    }
    return seed;
}

function validateNullableRarity(value: unknown, label: string): number | null {
    return value === null ? null : validateRarityIndex(value, label);
}

function validatePoolRecord<T>(
    source: unknown,
    tier: string,
    parseEntry: (value: unknown, label: string) => T,
): Record<string, Record<string, T>> {
    const movieRecord = requireRecord(source, `${tier} state`);
    if (Object.keys(movieRecord).length > SEED_MOVIE_IDS.length) {
        throw new Error(`${tier} state exceeds the movie limit`);
    }
    const result = createSeedRecord<Record<string, T>>();
    for (const [rawMovieId, rawEntries] of Object.entries(movieRecord)) {
        const movieId = validateMovieId(rawMovieId);
        const entries = requireRecord(rawEntries, `${movieId} ${tier} state`);
        const normalized = createSeedRecord<T>();
        for (const [seedKey, rawEntry] of Object.entries(entries)) {
            const seed = validateSeedKey(seedKey, `${movieId} ${tier} seed`);
            normalized[String(seed)] = parseEntry(rawEntry, `${movieId} ${tier} seed ${seed}`);
        }
        result[movieId] = normalized;
    }
    return result;
}

function assertCanonical(snapshot: SeedRuntimeSnapshot): void {
    const tiers = ["verified", "play", "confirmed", "pending"] as const;
    for (const movieId of SEED_MOVIE_IDS) {
        const seeds = new Set<string>();
        for (const tier of tiers) {
            for (const seed of Object.keys(snapshot[tier][movieId] ?? {})) seeds.add(seed);
        }
        for (const seed of seeds) {
            let highestTier: typeof tiers[number] | null = null;
            for (const tier of tiers) {
                const present = Object.prototype.hasOwnProperty.call(
                    snapshot[tier][movieId] ?? {},
                    seed,
                );
                if (!present) continue;
                if (highestTier === null) {
                    highestTier = tier;
                    continue;
                }
                throw new Error(
                    `Non-canonical seed ${seed} in movie ${movieId}: ${highestTier} conflicts with ${tier}`,
                );
            }
        }
    }
}

export function validateSeedRuntimeSnapshot(value: unknown): SeedRuntimeSnapshot {
    const root = requireRecord(value, "seed state snapshot");
    requireExactKeys(
        root,
        ["schemaVersion", "confirmed", "pending", "play", "verified", "config", "testSeeds"],
        "seed state snapshot",
    );
    if (root.schemaVersion !== 1) {
        throw new Error(`unsupported schemaVersion ${String(root.schemaVersion)}`);
    }

    const config = requireRecord(root.config, "config state");
    requireExactKeys(config, ["selectedMovieId"], "config state");
    const testSeeds = root.testSeeds;
    if (!Array.isArray(testSeeds) || testSeeds.length !== 3) {
        throw new Error("testSeeds must contain three entries");
    }

    const normalized: SeedRuntimeSnapshot = {
        schemaVersion: 1,
        confirmed: validatePoolRecord(root.confirmed, "confirmed", validateNullableRarity),
        pending: validatePoolRecord(root.pending, "pending", validateNullableRarity),
        play: validatePoolRecord(root.play, "play", (entry, label) => {
            const record = requireRecord(entry, label);
            requireExactKeys(record, ["r", "tag", "play"], label);
            if (record.play !== undefined && typeof record.play !== "boolean") {
                throw new Error(`${label}.play must be a boolean`);
            }
            return {
                r: validateRarityIndex(record.r, `${label}.r`),
                tag: validateSeedTag(record.tag),
                ...(record.play === undefined ? {} : { play: record.play }),
            };
        }),
        verified: validatePoolRecord(root.verified, "verified", (entry, label) => (
            validateRarityIndex(entry, label)
        )),
        config: { selectedMovieId: validateMovieId(config.selectedMovieId) },
        testSeeds: testSeeds.map(seed => seed === null ? null : validateTestSeed(seed)),
    };
    assertCanonical(normalized);
    return normalized;
}
