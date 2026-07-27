const fs = require("node:fs")
const path = require("node:path")

const { digestJson, loadSeedCatalog, verifySeedCatalog } = require("./catalog.cjs")
const { parseArguments } = require("./cli.cjs")
const world = require("./world.cjs")

const ROOT = path.join(__dirname, "..", "..")

function increment(distribution, value) {
    const key = String(value)
    distribution[key] = (distribution[key] ?? 0) + 1
}

function orderedDistribution(distribution) {
    return Object.fromEntries(
        Object.entries(distribution).sort(([left], [right]) => Number(left) - Number(right)),
    )
}

function auditMovie(pool, movieId) {
    const finalRarityCounts = { "3": 0, "4": 0, "5": 0 }
    const initialRarityCounts = { "3": 0, "4": 0, "5": 0 }
    const frameCountDistribution = {}
    const pinContactCountDistribution = {}
    const amuletContactCountDistribution = {}
    const rarityUpgradeCountDistribution = {}
    let moviePlayableCount = 0
    let seedCount = 0

    for (const rarityKey of ["1", "2", "3"]) {
        for (const seed of pool[rarityKey]["0"]) {
            const result = world.inspect(seed, movieId)
            seedCount += 1
            if (result.moviePlayable) moviePlayableCount += 1
            increment(initialRarityCounts, result.initialRarity + 3)
            increment(finalRarityCounts, result.finalRarity + 3)
            increment(frameCountDistribution, result.frameCount)
            increment(pinContactCountDistribution, result.pinContactCount)
            increment(amuletContactCountDistribution, result.amuletContactCount)
            increment(rarityUpgradeCountDistribution, result.rarityUpgradeCount)
        }
    }

    return {
        seedCount,
        moviePlayableCount,
        moviePlayableRate: seedCount === 0 ? 0 : moviePlayableCount / seedCount,
        initialRarityCounts,
        finalRarityCounts,
        frameCountDistribution: orderedDistribution(frameCountDistribution),
        pinContactCountDistribution: orderedDistribution(pinContactCountDistribution),
        amuletContactCountDistribution: orderedDistribution(amuletContactCountDistribution),
        rarityUpgradeCountDistribution: orderedDistribution(rarityUpgradeCountDistribution),
    }
}

function main(argv) {
    const args = parseArguments(argv)
    const directory = path.resolve(args.catalog ?? path.join(ROOT, "assets", "gacha-seed-catalog"))
    const output = path.resolve(args.output ?? path.join(directory, "audit.json"))
    const catalog = loadSeedCatalog(directory)
    verifySeedCatalog(catalog)

    const movies = {}
    for (const movieId of catalog.manifest.movieIds) {
        movies[movieId] = auditMovie(catalog.pools[movieId], movieId)
    }
    const audit = {
        schemaVersion: 1,
        manifestDigest: digestJson(catalog.manifest),
        totalSeedCount: catalog.manifest.totalSeedCount,
        movies,
    }

    const temporaryPath = `${output}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(audit), "utf8")
    fs.renameSync(temporaryPath, output)
    console.log(`audited ${audit.totalSeedCount} seeds: ${output}`)
}

try {
    main(process.argv.slice(2))
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}
