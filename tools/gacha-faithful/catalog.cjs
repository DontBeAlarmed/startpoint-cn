const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const SCHEMA_VERSION = 1
const MAX_SEED = 2_147_483_647
const RARITY_KEYS = Object.freeze(["1", "2", "3"])

function requireInteger(value, label) {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer`)
    }
    return value
}

function requireRarityIndex(value, label) {
    const rarity = requireInteger(value, label)
    if (rarity < 0 || rarity > 2) {
        throw new RangeError(`${label} must be 0, 1, or 2`)
    }
    return rarity
}

function requireSeedRange(start, end) {
    const seedStart = requireInteger(start, "seedStart")
    const seedEnd = requireInteger(end, "seedEnd")
    if (seedStart < 0 || seedEnd > MAX_SEED || seedStart > seedEnd) {
        throw new RangeError(`seed range must be within 0..${MAX_SEED} and not be reversed`)
    }
    return { seedStart, seedEnd }
}

function digestJson(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function createEmptyPool() {
    return {
        "1": { "0": [] },
        "2": { "0": [] },
        "3": { "0": [] },
    }
}

function writeJsonAtomic(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(value), "utf8")
    fs.renameSync(temporaryPath, filePath)
}

function writeSeedCatalog(directory, catalog) {
    verifySeedCatalog(catalog)
    fs.mkdirSync(directory, { recursive: true })
    for (const movieId of catalog.manifest.movieIds) {
        writeJsonAtomic(path.join(directory, `${movieId}.json`), catalog.pools[movieId])
    }
    writeJsonAtomic(path.join(directory, "manifest.json"), catalog.manifest)
}

function loadSeedCatalog(directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
    const pools = {}
    for (const movieId of manifest.movieIds) {
        pools[movieId] = JSON.parse(fs.readFileSync(path.join(directory, `${movieId}.json`), "utf8"))
    }
    return { manifest, pools }
}

function buildSeedCatalog(options) {
    const { seedStart, seedEnd } = requireSeedRange(options.seedStart, options.seedEnd)
    if (typeof options.classify !== "function") throw new TypeError("classify must be a function")

    const movieIds = [...new Set(options.movieIds ?? [])].sort()
    if (movieIds.length === 0) throw new RangeError("movieIds must not be empty")

    const pools = {}

    for (const movieId of movieIds) {
        const pool = createEmptyPool()
        for (let seed = seedStart; seed <= seedEnd; seed += 1) {
            const rarity = requireRarityIndex(
                options.classify(seed, movieId),
                `${movieId} seed ${seed} rarity`,
            )
            pool[String(3 - rarity)]["0"].push(seed)
        }
        pools[movieId] = pool
    }

    return buildSeedCatalogFromPools({ ...options, pools })
}

function buildSeedCatalogFromPools(options) {
    const { seedStart, seedEnd } = requireSeedRange(options.seedStart, options.seedEnd)

    const movieIds = Object.keys(options.pools ?? {}).sort()
    if (movieIds.length === 0) throw new RangeError("pools must not be empty")
    const pools = {}
    const poolDigests = {}
    const rarityCounts = {}

    for (const movieId of movieIds) {
        const source = options.pools[movieId]
        const pool = createEmptyPool()
        for (const rarityKey of RARITY_KEYS) {
            if (!Array.isArray(source?.[rarityKey]?.["0"])) {
                throw new TypeError(`missing ${movieId} rarity bucket ${rarityKey}`)
            }
            pool[rarityKey]["0"] = [...source[rarityKey]["0"]]
        }
        pools[movieId] = pool
        poolDigests[movieId] = digestJson(pool)
        rarityCounts[movieId] = {
            "3": pool["3"]["0"].length,
            "4": pool["2"]["0"].length,
            "5": pool["1"]["0"].length,
        }
    }

    const seedCountPerMovie = seedEnd - seedStart + 1
    const catalog = {
        manifest: {
            schemaVersion: SCHEMA_VERSION,
            clientVersion: String(options.clientVersion),
            cdnVersion: String(options.cdnVersion),
            configDigest: String(options.configDigest),
            predictorDigest: String(options.predictorDigest),
            seedRange: { start: seedStart, end: seedEnd },
            movieIds,
            seedCountPerMovie,
            totalSeedCount: seedCountPerMovie * movieIds.length,
            rarityCounts,
            poolDigests,
        },
        pools,
    }
    verifySeedCatalog(catalog)
    return catalog
}

function verifySeedCatalog(catalog, options = {}) {
    if (!catalog || typeof catalog !== "object") throw new TypeError("catalog must be an object")
    const manifest = catalog.manifest
    const pools = catalog.pools
    if (!manifest || !pools) throw new TypeError("catalog must contain manifest and pools")
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`unsupported seed catalog schema ${manifest.schemaVersion}`)
    }

    const { seedStart, seedEnd } = requireSeedRange(
        manifest.seedRange?.start,
        manifest.seedRange?.end,
    )
    const expectedCount = seedEnd - seedStart + 1
    let totalSeedCount = 0

    for (const movieId of manifest.movieIds) {
        const pool = pools[movieId]
        if (!pool) throw new Error(`missing movie pool ${movieId}`)
        const seen = new Set()

        for (const rarityKey of RARITY_KEYS) {
            const seeds = pool[rarityKey]?.["0"]
            if (!Array.isArray(seeds)) throw new Error(`missing ${movieId} rarity bucket ${rarityKey}`)
            for (const seedValue of seeds) {
                const seed = requireInteger(seedValue, `${movieId} seed`)
                if (seed < seedStart || seed > seedEnd) {
                    throw new Error(`${movieId} seed ${seed} is outside manifest range`)
                }
                if (seen.has(seed)) throw new Error(`${movieId} duplicate seed ${seed}`)
                seen.add(seed)

                if (typeof options.classify === "function") {
                    const actualRarity = requireRarityIndex(
                        options.classify(seed, movieId),
                        `${movieId} seed ${seed} rarity`,
                    )
                    const bucketRarity = 3 - Number(rarityKey)
                    if (actualRarity !== bucketRarity) {
                        throw new Error(
                            `${movieId} seed ${seed} rarity mismatch: bucket=${bucketRarity}, actual=${actualRarity}`,
                        )
                    }
                }
            }
        }

        for (let seed = seedStart; seed <= seedEnd; seed += 1) {
            if (!seen.has(seed)) throw new Error(`${movieId} missing seed ${seed}`)
        }
        if (seen.size !== expectedCount) {
            throw new Error(`${movieId} seed count mismatch: expected ${expectedCount}, got ${seen.size}`)
        }
        if (manifest.poolDigests?.[movieId] !== digestJson(pool)) {
            throw new Error(`${movieId} pool digest mismatch`)
        }
        const actualRarityCounts = {
            "3": pool["3"]["0"].length,
            "4": pool["2"]["0"].length,
            "5": pool["1"]["0"].length,
        }
        if (JSON.stringify(manifest.rarityCounts?.[movieId]) !== JSON.stringify(actualRarityCounts)) {
            throw new Error(`${movieId} rarity counts mismatch`)
        }
        totalSeedCount += seen.size
    }

    if (manifest.seedCountPerMovie !== expectedCount) throw new Error("manifest seed count mismatch")
    if (manifest.totalSeedCount !== totalSeedCount) throw new Error("manifest total seed count mismatch")
    if (options.configDigest !== undefined && manifest.configDigest !== options.configDigest) {
        throw new Error("config digest mismatch")
    }
    if (options.predictorDigest !== undefined && manifest.predictorDigest !== options.predictorDigest) {
        throw new Error("predictor digest mismatch")
    }

    return {
        movieCount: manifest.movieIds.length,
        seedCountPerMovie: expectedCount,
        totalSeedCount,
    }
}

module.exports = {
    SCHEMA_VERSION,
    buildSeedCatalog,
    buildSeedCatalogFromPools,
    digestJson,
    loadSeedCatalog,
    verifySeedCatalog,
    writeSeedCatalog,
}
