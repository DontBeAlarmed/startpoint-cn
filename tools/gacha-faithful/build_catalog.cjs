const os = require("node:os")
const path = require("node:path")
const { Worker } = require("node:worker_threads")

const { buildSeedCatalogFromPools, writeSeedCatalog } = require("./catalog.cjs")
const { DEFAULT_SEED_END, DEFAULT_SEED_START } = require("./catalog_defaults.cjs")
const { currentCatalogMetadata } = require("./catalog_metadata.cjs")
const { integerArgument, parseArguments } = require("./cli.cjs")
const { loadServerReleaseContract } = require("../server-bundle/release-contract.cjs")

const ROOT = path.join(__dirname, "..", "..")
const BUNDLED_CDN_CATALOG_VERSION = loadServerReleaseContract(ROOT).bundledCdnCatalogVersion
const DEFAULT_MOVIES = ["normal", "normal_guarantee", "fes", "fes_guarantee"]
const SUPPORTED_MOVIES = new Set(DEFAULT_MOVIES)

function createJobs(movieIds, seedStart, seedEnd, workers) {
    const seedCount = seedEnd - seedStart + 1
    const chunkCount = Math.min(workers, seedCount)
    const chunkSize = Math.ceil(seedCount / chunkCount)
    const jobs = []
    for (const movieId of movieIds) {
        for (let start = seedStart; start <= seedEnd; start += chunkSize) {
            jobs.push({ movieId, seedStart: start, seedEnd: Math.min(seedEnd, start + chunkSize - 1) })
        }
    }
    return jobs
}

function runWorker(job) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "catalog_worker.cjs"), { workerData: job })
        worker.once("message", resolve)
        worker.once("error", reject)
        worker.once("exit", code => {
            if (code !== 0) reject(new Error(`seed catalog worker stopped with exit code ${code}`))
        })
    })
}

async function runWorkerQueue(jobs, workerCount) {
    const results = new Array(jobs.length)
    let nextIndex = 0
    async function consume() {
        while (nextIndex < jobs.length) {
            const index = nextIndex
            nextIndex += 1
            results[index] = await runWorker(jobs[index])
        }
    }
    await Promise.all(Array.from({ length: Math.min(workerCount, jobs.length) }, consume))
    return results
}

function mergePools(movieIds, results) {
    const pools = {}
    for (const movieId of movieIds) {
        pools[movieId] = { "1": { "0": [] }, "2": { "0": [] }, "3": { "0": [] } }
        const chunks = results
            .filter(result => result.movieId === movieId)
            .sort((left, right) => left.seedStart - right.seedStart)
        for (const chunk of chunks) {
            for (const rarityKey of ["1", "2", "3"]) {
                pools[movieId][rarityKey]["0"].push(...chunk.pool[rarityKey]["0"])
            }
        }
    }
    return pools
}

async function main(argv) {
    const args = parseArguments(argv)
    const output = path.resolve(args.output ?? path.join(ROOT, "assets", "gacha-seed-catalog"))
    const seedStart = integerArgument(args, "seed-start", DEFAULT_SEED_START)
    const seedEnd = integerArgument(args, "seed-end", DEFAULT_SEED_END)
    const movieIds = (args.movies ?? DEFAULT_MOVIES.join(","))
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
    const unknownMovie = movieIds.find(movieId => !SUPPORTED_MOVIES.has(movieId))
    if (unknownMovie) throw new Error(`unsupported movie: ${unknownMovie}`)
    if (seedStart < 0 || seedEnd > 2_147_483_647 || seedStart > seedEnd) {
        throw new Error("seed range must be within 0..2147483647 and not be reversed")
    }
    const requestedWorkers = integerArgument(args, "workers", Math.min(4, os.availableParallelism()))
    if (requestedWorkers < 1 || requestedWorkers > 4) {
        throw new Error("--workers must be within 1..4")
    }

    const startedAt = Date.now()
    const jobs = createJobs(movieIds, seedStart, seedEnd, requestedWorkers)
    const workerCount = Math.min(requestedWorkers, jobs.length)
    const results = await runWorkerQueue(jobs, workerCount)
    const metadata = currentCatalogMetadata()
    const catalog = buildSeedCatalogFromPools({
        clientVersion: args["client-version"] ?? "1.8.1",
        cdnVersion: args["cdn-version"] ?? BUNDLED_CDN_CATALOG_VERSION,
        configDigest: metadata.configDigest,
        predictorDigest: metadata.predictorDigest,
        seedStart,
        seedEnd,
        pools: mergePools(movieIds, results),
    })
    writeSeedCatalog(output, catalog)
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(
        `built ${catalog.manifest.totalSeedCount} seeds across ${movieIds.length} movies with ${workerCount} workers in ${elapsedSeconds}s: ${output}`,
    )
}

main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
