"use strict"

const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const {
    productionContentSnapshotProvider,
} = require("../../src/content/runtime/content-snapshot")

const tableNames = [
    "general_shop.json",
    "event_item_shop.json",
    "event_item_shop_id_map.json",
    "boss_coin_shop.json",
    "boss_coin_shop_item_category_map.json",
    "star_grain_shop.json",
    "treasure_shop.json",
    "equipment_enhancement_shop.json",
]

function installBundledShopSnapshot() {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const tables = Object.fromEntries(tableNames.map(tableName => [
        tableName,
        require(path.join(projectRoot, "assets", tableName)),
    ]))
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "1.4.54" },
        repository: {
            info: () => ({
                source: "bundled",
                assetVersion: "1.4.54",
                generatorVersion: 1,
                releaseDigest: null,
            }),
            table(tableName) {
                if (!(tableName in tables)) throw new Error(`unexpected shop table ${tableName}`)
                return tables[tableName]
            },
        },
    }
    let restored = false
    return () => {
        if (restored) return
        restored = true
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
}

module.exports = { installBundledShopSnapshot }
