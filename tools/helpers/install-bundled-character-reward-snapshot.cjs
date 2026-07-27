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
const CHARACTER_CONTENT_TABLE_NAME = "cdndata/character.json"
const REWARD_TABLE_NAMES = [
    "clear_reward.json",
    "score_reward.json",
    "rare_score_reward.json",
    "rush_event_quest_folder.json",
    "score_attack_border_reward.json",
    "rush_event_ranking_reward.json",
]

function installBundledCharacterAndRewardSnapshot({ onRestore } = {}) {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const characterTable = deepFreeze(structuredClone(
        require(path.join(projectRoot, "assets", CHARACTER_TABLE_NAME))
    ))
    const characterContentTable = deepFreeze(structuredClone(
        require(path.join(projectRoot, "assets", CHARACTER_CONTENT_TABLE_NAME))
    ))
    const rewardTables = Object.fromEntries(REWARD_TABLE_NAMES.map(tableName => [
        tableName,
        deepFreeze(structuredClone(require(path.join(projectRoot, "assets", tableName)))),
    ]))
    const repositoryInfo = deepFreeze({
        source: "bundled",
        assetVersion: BUNDLED_CDN_CATALOG_VERSION,
        generatorVersion: 1,
        releaseDigest: null,
    })
    const repository = deepFreeze({
        info: () => repositoryInfo,
        table(tableName) {
            if (tableName === CHARACTER_TABLE_NAME) return characterTable
            if (tableName === CHARACTER_CONTENT_TABLE_NAME) return characterContentTable
            if (tableName in rewardTables) return rewardTables[tableName]
            throw new Error(`unexpected character/reward table ${tableName}`)
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

module.exports = { installBundledCharacterAndRewardSnapshot }
