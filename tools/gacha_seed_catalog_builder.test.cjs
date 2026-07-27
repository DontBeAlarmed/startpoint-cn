const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const {
    buildSeedCatalog,
    buildSeedCatalogFromPools,
    loadSeedCatalog,
    verifySeedCatalog,
    writeSeedCatalog,
} = require("./gacha-faithful/catalog.cjs")

const MOVIE_RESULTS = Object.freeze({
    normal: [1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0],
    normal_guarantee: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    fes: [0, 0, 0, 0, 2, 0, 1, 1, 0, 0, 0, 2],
    fes_guarantee: [1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2],
})

function buildFixture() {
    return buildSeedCatalog({
        clientVersion: "1.8.1",
        cdnVersion: "1.4.54",
        configDigest: "config-sha256",
        predictorDigest: "predictor-sha256",
        seedStart: 1,
        seedEnd: 12,
        movieIds: Object.keys(MOVIE_RESULTS),
        classify(seed, movieId) {
            return MOVIE_RESULTS[movieId][seed - 1]
        },
    })
}

const catalog = buildFixture()

assert.deepStrictEqual(catalog.manifest.seedRange, { start: 1, end: 12 })
assert.equal(catalog.manifest.seedCountPerMovie, 12)
assert.equal(catalog.manifest.totalSeedCount, 48)
assert.deepStrictEqual(catalog.pools.normal, {
    "1": { "0": [] },
    "2": { "0": [1, 5, 7, 8] },
    "3": { "0": [2, 3, 4, 6, 9, 10, 11, 12] },
})
assert.deepStrictEqual(catalog.pools.fes, {
    "1": { "0": [5, 12] },
    "2": { "0": [7, 8] },
    "3": { "0": [1, 2, 3, 4, 6, 9, 10, 11] },
})
assert.deepStrictEqual(verifySeedCatalog(catalog), {
    movieCount: 4,
    seedCountPerMovie: 12,
    totalSeedCount: 48,
})

const rebuilt = buildFixture()
assert.deepStrictEqual(rebuilt, catalog, "same inputs must produce a byte-stable catalog model")
assert.deepStrictEqual(
    buildSeedCatalogFromPools({
        clientVersion: "1.8.1",
        cdnVersion: "1.4.54",
        configDigest: "config-sha256",
        predictorDigest: "predictor-sha256",
        seedStart: 1,
        seedEnd: 12,
        pools: catalog.pools,
    }),
    catalog,
)

const duplicate = structuredClone(catalog)
duplicate.pools.normal["2"]["0"].push(1)
assert.throws(
    () => verifySeedCatalog(duplicate),
    /duplicate seed 1/i,
)

const missing = structuredClone(catalog)
missing.pools.normal["2"]["0"].shift()
assert.throws(
    () => verifySeedCatalog(missing),
    /missing seed 1/i,
)

const wrongRarity = structuredClone(catalog)
wrongRarity.pools.fes["1"]["0"].pop()
wrongRarity.pools.fes["2"]["0"].push(12)
assert.throws(
    () => verifySeedCatalog(wrongRarity, {
        classify(seed, movieId) {
            return MOVIE_RESULTS[movieId][seed - 1]
        },
    }),
    /seed 12.*rarity/i,
)

const wrongCounts = structuredClone(catalog)
wrongCounts.manifest.rarityCounts.normal["3"] += 1
assert.throws(
    () => verifySeedCatalog(wrongCounts),
    /rarity counts mismatch/i,
)

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "starpoint-seed-catalog-"))
try {
    writeSeedCatalog(temporaryRoot, catalog)
    assert.deepStrictEqual(loadSeedCatalog(temporaryRoot), catalog)

    const normalPath = path.join(temporaryRoot, "normal.json")
    const changedPool = JSON.parse(fs.readFileSync(normalPath, "utf8"))
    changedPool["2"]["0"].push(2)
    fs.writeFileSync(normalPath, JSON.stringify(changedPool))
    assert.throws(
        () => verifySeedCatalog(loadSeedCatalog(temporaryRoot)),
        /duplicate seed 2|pool digest mismatch/i,
    )
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

console.log("gacha seed catalog builder tests passed")
