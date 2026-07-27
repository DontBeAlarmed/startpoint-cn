const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { digestJson } = require("./catalog.cjs")
const world = require("./world.cjs")

function digestPredictor() {
    const hash = createHash("sha256")
    for (const fileName of ["world.cjs", "native_hotpath.cjs"]) {
        hash.update(fileName)
        hash.update(fs.readFileSync(path.join(__dirname, fileName)))
    }
    return hash.digest("hex")
}

function currentCatalogMetadata() {
    return {
        configDigest: digestJson(world.getConfigSnapshot()),
        predictorDigest: digestPredictor(),
    }
}

module.exports = { currentCatalogMetadata }
