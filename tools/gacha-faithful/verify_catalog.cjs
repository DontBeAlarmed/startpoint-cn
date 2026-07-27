const path = require("node:path")

const { loadSeedCatalog, verifySeedCatalog } = require("./catalog.cjs")
const { currentCatalogMetadata } = require("./catalog_metadata.cjs")
const { parseArguments } = require("./cli.cjs")
const world = require("./world.cjs")

const ROOT = path.join(__dirname, "..", "..")

function main(argv) {
    const args = parseArguments(argv)
    const directory = path.resolve(args.catalog ?? path.join(ROOT, "assets", "gacha-seed-catalog"))
    const catalog = loadSeedCatalog(directory)
    const metadata = currentCatalogMetadata()
    const result = verifySeedCatalog(catalog, {
        classify: world.simulate,
        configDigest: metadata.configDigest,
        predictorDigest: metadata.predictorDigest,
    })
    console.log(`verified ${result.totalSeedCount} seeds across ${result.movieCount} movies: ${directory}`)
}

try {
    main(process.argv.slice(2))
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}
