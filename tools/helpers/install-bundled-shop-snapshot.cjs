"use strict"

const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const {
    productionContentSnapshotProvider,
} = require("../../src/content/runtime/content-snapshot")

const tableNames = [
    "cdn_general_shop_whitelist.json",
    "general_shop.json",
    "event_item_shop.json",
    "event_item_shop_id_map.json",
    "boss_coin_shop.json",
    "boss_coin_shop_item_category_map.json",
    "shop_select_item_campaign.json",
    "shop_item_campaign.json",
    "star_grain_shop.json",
    "treasure_shop.json",
    "equipment_enhancement_shop.json",
    "special_pack_shop.json",
    "mana_shop.json",
    "shop_cost_item_schedule.json",
    "config.json",
    "item_data.json",
    "item_ids.json",
    "item_lookup.json",
    "item_sale.json",
    // Shop purchases publish Active Mission progress in the same transaction,
    // so the fixed point also reads the mission content tables; the mana
    // spend hook builds the full mission catalog, which parses every
    // category's definition and reward tables.
    "mission_active.json",
    "mission_active_event.json",
    "mission_active_reward.json",
    "mission_regular.json",
    "mission_regular_reward.json",
    "mission_daily.json",
    "mission_daily_reward.json",
    "mission_event.json",
    "mission_event_reward.json",
    "mission_collect_item.json",
    "mission_collect_item_reward.json",
    "mission_degree.json",
    "mission_degree_reward.json",
    "mission_pass_daily.json",
    "mission_pass_daily_reward.json",
    "mission_pass_week.json",
    "mission_pass_week_reward.json",
    "mission_pass_event.json",
    "mission_pass_event_reward.json",
    "mission_char_awake.json",
    "mission_char_awake_reward.json",
    "mission_weekly_def.json",
    "mission_weekly_reward.json",
    // Quest-range translation and regular/degree/event rule catalogs read
    // these content tables through the mission catalog.
    "main_quest.json",
    "ex_quest.json",
    "practice_quest.json",
    "boss_battle_quest.json",
    "character.json",
    "mana_board.json",
    "mission_event_battle_rules.json",
    "mission_event_quest_map.json",
    "character_quest_lookup.json",
    "equipment_dissolve.json",
    "item_sale.json",
    "score_attack_event_quest.json",
    "advent_event_quest.json",
    "ranking_event_single_quest.json",
    "rush_event_quest.json",
    "carnival_event_quest.json",
    "hard_multi_event_quest.json",
    "story_event_single_quest.json",
    "challenge_dungeon_event_quest.json",
    "expert_single_event_quest.json",
    "world_story_event_quest.json",
]

function installBundledShopSnapshot({ additionalTableNames = [] } = {}) {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const tables = Object.fromEntries([...tableNames, ...additionalTableNames].map(tableName => [
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

// Reinstalls the currently installed snapshot with a fresh repository identity
// that delegates to the same repository. Shop tests mutate the required asset
// objects in place; per-repository catalog caches only rebuild for a new
// repository identity, so an identity refresh makes those mutations visible
// without going through the provider singleton directly.
function installRefreshedShopRepositoryIdentity() {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const repository = previousSnapshot.repository
    productionContentSnapshotProvider.snapshot = {
        ...previousSnapshot,
        repository: {
            info: () => repository.info(),
            table: tableName => repository.table(tableName),
        },
    }
    let restored = false
    return () => {
        if (restored) return
        restored = true
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
}

module.exports = { installBundledShopSnapshot, installRefreshedShopRepositoryIdentity }
