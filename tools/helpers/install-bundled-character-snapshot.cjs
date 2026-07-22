"use strict"

const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const {
    BUNDLED_CDN_CATALOG_VERSION,
} = require("../../src/content/constants")
const { deepFreeze } = require("../../src/content/deep-freeze")
const {
    productionContentSnapshotProvider,
} = require("../../src/content/runtime/content-snapshot")

const CHARACTER_TABLE_NAME = "character.json"

function installBundledCharacterSnapshot({ onRestore } = {}) {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const characterTable = deepFreeze(structuredClone(
        require(path.join(projectRoot, "assets", CHARACTER_TABLE_NAME))
    ))
    const repositoryInfo = deepFreeze({
        source: "bundled",
        assetVersion: BUNDLED_CDN_CATALOG_VERSION,
        generatorVersion: 1,
        releaseDigest: null,
    })
    const repository = deepFreeze({
        info: () => repositoryInfo,
        table(tableName) {
            if (tableName !== CHARACTER_TABLE_NAME) {
                throw new Error(`unexpected character table ${tableName}`)
            }
            return characterTable
        },
    })

    productionContentSnapshotProvider.snapshot = deepFreeze({
        cdn: { targetVersion: BUNDLED_CDN_CATALOG_VERSION },
        repository,
    })

    let restored = false
    return () => {
        if (restored) return
        restored = true
        productionContentSnapshotProvider.snapshot = previousSnapshot
        onRestore?.()
    }
}

module.exports = { installBundledCharacterSnapshot }
