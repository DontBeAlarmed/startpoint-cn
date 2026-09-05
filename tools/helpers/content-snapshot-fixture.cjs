"use strict"

const {
    deepFreeze,
} = require("../../src/content/deep-freeze")
const {
    productionContentSnapshotProvider,
} = require("../../src/content/runtime/content-snapshot")

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`

function createFrozenTestContentRepository({
    tables,
    assetVersion = "test",
    source = "bundled",
} = {}) {
    if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        throw new TypeError("test content tables must be an object")
    }
    const frozenTables = deepFreeze(structuredClone(tables))
    const info = deepFreeze({
        source,
        assetVersion,
        generatorVersion: 1,
        releaseDigest: null,
        contentDigest: ZERO_DIGEST,
        multiBattleContentDigest: ZERO_DIGEST,
    })
    return deepFreeze({
        info: () => info,
        table(tableName) {
            if (!Object.prototype.hasOwnProperty.call(frozenTables, tableName)) {
                throw new Error(`missing test content table: ${tableName}`)
            }
            return frozenTables[tableName]
        },
    })
}

function createFrozenTestContentSnapshot({
    tables,
    targetVersion = "test",
    assetVersion = targetVersion,
} = {}) {
    return deepFreeze({
        cdn: { targetVersion },
        archiveSources: { schemaVersion: 1, archives: [] },
        repository: createFrozenTestContentRepository({ tables, assetVersion }),
    })
}

function installFrozenTestContentSnapshot(options) {
    const previous = productionContentSnapshotProvider.snapshot
    const snapshot = createFrozenTestContentSnapshot(options)
    productionContentSnapshotProvider.snapshot = snapshot
    let restored = false
    return {
        snapshot,
        restore() {
            if (restored) return
            restored = true
            productionContentSnapshotProvider.snapshot = previous
        },
    }
}

module.exports = {
    createFrozenTestContentRepository,
    createFrozenTestContentSnapshot,
    installFrozenTestContentSnapshot,
}
