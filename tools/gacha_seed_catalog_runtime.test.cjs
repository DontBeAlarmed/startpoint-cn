require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const {
    GachaSeedCatalog,
    reserveUniquePlaceholderSeed,
} = require("../src/lib/gacha-seed-catalog.ts")

function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function writeFixture(directory) {
    const pools = {
        fes: {
            "1": { "0": [101, 102] },
            "2": { "0": [103, 104] },
            "3": { "0": [105, 106] },
        },
        fes_guarantee: {
            "1": { "0": [101, 102] },
            "2": { "0": [103, 104] },
            "3": { "0": [105, 106] },
        },
        normal: {
            "1": { "0": [101, 102] },
            "2": { "0": [103, 104] },
            "3": { "0": [105, 106] },
        },
        normal_guarantee: {
            "1": { "0": [101, 102] },
            "2": { "0": [103, 104] },
            "3": { "0": [105, 106] },
        },
    }
    const manifest = {
        schemaVersion: 1,
        clientVersion: "1.8.1",
        cdnVersion: "1.4.54",
        configDigest: "a".repeat(64),
        predictorDigest: "b".repeat(64),
        seedRange: { start: 101, end: 106 },
        movieIds: Object.keys(pools),
        seedCountPerMovie: 6,
        totalSeedCount: 24,
        rarityCounts: Object.fromEntries(
            Object.keys(pools).map(movieId => [movieId, { "3": 2, "4": 2, "5": 2 }]),
        ),
        poolDigests: Object.fromEntries(
            Object.entries(pools).map(([movieId, pool]) => [movieId, digest(pool)]),
        ),
    }
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest))
    for (const [movieId, pool] of Object.entries(pools)) {
        fs.writeFileSync(path.join(directory, `${movieId}.json`), JSON.stringify(pool))
    }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "starpoint-runtime-seeds-"))
try {
    writeFixture(temporaryRoot)
    let readCount = 0
    const catalog = new GachaSeedCatalog({
        catalogDir: temporaryRoot,
        readFile(filePath) {
            readCount += 1
            return fs.readFileSync(filePath, "utf8")
        },
        randomInt(maxExclusive) {
            return maxExclusive - 1
        },
    })

    assert.equal(readCount, 5)
    assert.deepStrictEqual(catalog.status(), {
        schemaVersion: 1,
        clientVersion: "1.8.1",
        cdnVersion: "1.4.54",
        seedRange: { start: 101, end: 106 },
        totalSeedCount: 24,
        movies: [
            { movieId: "fes", rarityCounts: { "3": 2, "4": 2, "5": 2 } },
            { movieId: "fes_guarantee", rarityCounts: { "3": 2, "4": 2, "5": 2 } },
            { movieId: "normal", rarityCounts: { "3": 2, "4": 2, "5": 2 } },
            { movieId: "normal_guarantee", rarityCounts: { "3": 2, "4": 2, "5": 2 } },
        ],
    })
    const used = new Set()
    assert.equal(catalog.select("normal", 5, used), 102)
    assert.equal(catalog.select("normal", 5, used), 101)
    assert.deepStrictEqual([...used], [102, 101])
    assert.equal(catalog.select("normal", 4, used), 104)
    assert.equal(catalog.select("normal_guarantee", 5, new Set()), 102)
    assert.equal(readCount, 5, "selection must use the startup cache")

    assert.throws(
        () => catalog.select("normal", 5, used),
        /no available.*normal.*rarity 5/i,
    )
    assert.throws(
        () => catalog.select("unknown", 4, new Set()),
        /unknown gacha movie/i,
    )

    const normalPath = path.join(temporaryRoot, "normal.json")
    const changed = JSON.parse(fs.readFileSync(normalPath, "utf8"))
    changed["1"]["0"].reverse()
    fs.writeFileSync(normalPath, JSON.stringify(changed))
    assert.throws(
        () => new GachaSeedCatalog({ catalogDir: temporaryRoot }),
        /digest mismatch/i,
    )

    writeFixture(temporaryRoot)
    const filtered = new GachaSeedCatalog({
        catalogDir: temporaryRoot,
        isQuarantined: (movieId, seed) => movieId === "normal" && seed === 102,
        randomInt: maxExclusive => maxExclusive - 1,
    })
    assert.equal(filtered.select("normal", 5, new Set()), 101)

    const manifestPath = path.join(temporaryRoot, "manifest.json")
    const mutateManifest = mutator => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        mutator(manifest)
        fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    }

    writeFixture(temporaryRoot)
    mutateManifest(manifest => { manifest.configDigest = "invalid" })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /digest/i)

    writeFixture(temporaryRoot)
    mutateManifest(manifest => { manifest.seedRange.end = 100 })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /range/i)

    writeFixture(temporaryRoot)
    mutateManifest(manifest => {
        manifest.movieIds = manifest.movieIds.slice(1)
        manifest.totalSeedCount = 18
    })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /movie/i)

    writeFixture(temporaryRoot)
    mutateManifest(manifest => { manifest.seedCountPerMovie = 5 })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /seed count/i)

    writeFixture(temporaryRoot)
    mutateManifest(manifest => { manifest.rarityCounts.normal["5"] = 1 })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /rarity count/i)

    writeFixture(temporaryRoot)
    const outOfRangePool = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "normal.json"), "utf8"))
    outOfRangePool["3"]["0"][1] = 999
    fs.writeFileSync(path.join(temporaryRoot, "normal.json"), JSON.stringify(outOfRangePool))
    mutateManifest(manifest => { manifest.poolDigests.normal = digest(outOfRangePool) })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /outside.*range|missing seed/i)

    writeFixture(temporaryRoot)
    mutateManifest(manifest => { manifest.clientVersion = "1.8.2" })
    assert.throws(() => new GachaSeedCatalog({ catalogDir: temporaryRoot }), /client version/i)

    const placeholders = new Set()
    assert.equal(reserveUniquePlaceholderSeed(9000, placeholders), 9000)
    assert.equal(reserveUniquePlaceholderSeed(9000, placeholders), 9001)
    assert.deepStrictEqual([...placeholders], [9000, 9001])
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

const gachaSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "gacha.ts"), "utf8")
assert.match(gachaSource, /getDefaultGachaSeedCatalog\(\)/)
assert.doesNotMatch(gachaSource, /gacha-physics/)
assert.match(gachaSource, /movieId !== "rarity_5_guarantee"/)
assert.match(gachaSource, /const usedSeeds = new Set<number>\(\)/)
assert.match(gachaSource, /gachaSeedCatalog\.select\(movieId, rarity, usedSeeds\)/)
assert.match(gachaSource, /planCharacterGachaMovies/)
assert.doesNotMatch(gachaSource, /loadMovieSeeds|getPlayForRarity|seedValidator\.getSeed/)
assert.equal(
    (gachaSource.match(/characterId \* 1000/g) ?? []).length,
    1,
    "only the rarity_5_guarantee planner may derive a placeholder seed from character id",
)
assert.equal(
    gachaSource.indexOf("const characterMoviePlan = planCharacterGachaMovies")
        < gachaSource.indexOf("const giveResult = givePlayerCharacterSync"),
    true,
    "all seeds must be planned before the first character write",
)

const gachaRouteSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "api", "gacha.ts"),
    "utf8",
)
assert.equal(
    gachaRouteSource.indexOf("const characterMoviePlan = isCharacterGacha")
        < gachaRouteSource.indexOf("updatePlayerItemSync(playerId"),
    true,
    "the regular route must plan seeds before ticket or campaign writes",
)

console.log("gacha seed catalog runtime tests passed")
