const { parentPort, workerData } = require("node:worker_threads")

const world = require("./world.cjs")

const pool = {
    "1": { "0": [] },
    "2": { "0": [] },
    "3": { "0": [] },
}

for (let seed = workerData.seedStart; seed <= workerData.seedEnd; seed += 1) {
    const rarity = world.simulate(seed, workerData.movieId)
    pool[String(3 - rarity)]["0"].push(seed)
}

parentPort.postMessage({ ...workerData, pool })
