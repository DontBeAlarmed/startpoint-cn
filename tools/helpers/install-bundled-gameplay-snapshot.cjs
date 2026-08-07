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
const QUEST_TABLE_NAMES = [
    "main_quest.json",
    "ex_quest.json",
    "boss_battle_quest.json",
    "character_quest.json",
    "world_story_event_quest.json",
    "world_story_event_boss_battle_quest.json",
    "advent_event_quest.json",
    "daily_exp_mana_event_quest.json",
    "daily_week_event_quest.json",
    "challenge_dungeon_event_quest.json",
    "story_event_single_quest.json",
    "ranking_event_single_quest.json",
    "solo_time_attack_event_quest.json",
    "tower_dungeon_event_quest.json",
    "expert_single_event_quest.json",
    "carnival_event_quest.json",
    "rush_event_quest.json",
    "raid_event_quest.json",
    "score_attack_event_quest.json",
    "hard_multi_event_quest.json",
    "daily_challenge_point_lookup.json",
    "event_challenge_point_map.json",
    "quest_entry_costs.json",
    "quest_lookup.json",
    "quest_unlock_costs.json",
]
const GAMEPLAY_DYNAMIC_TABLE_NAMES = [
    "additional_reward_rules.json",
    "box_gacha.json",
    "box_gacha_box_settings.json",
    "box_reward.json",
    "carnival_event_total_score_reward.json",
    "equipment_gacha_movie_probability.json",
    "ex_ability.json",
    "ex_boost.json",
    "ex_status.json",
    "equipment_craft.json",
    "equipment_dissolve.json",
    "equipment_ids.json",
    "equipment_lookup.json",
    "item_data.json",
    "item_ids.json",
    "item_lookup.json",
    "item_sale.json",
    "mana_board.json",
    "mana_board2_open_condition.json",
    "mana_node.json",
    "mana_node_awake.json",
    "mission_active.json",
    "mission_active_event.json",
    "mission_active_reward.json",
    "mission_regular.json",
    "mission_daily.json",
    "mission_event.json",
    "mission_collect_item.json",
    "mission_degree.json",
    "mission_char_awake.json",
    "mission_weekly_def.json",
    "mission_pass_daily.json",
    "mission_pass_week.json",
    "mission_pass_event.json",
    "mission_regular_reward.json",
    "mission_daily_reward.json",
    "mission_event_reward.json",
    "mission_degree_reward.json",
    "mission_collect_item_reward.json",
    "mission_weekly_reward.json",
    "mission_char_awake_reward.json",
    "mission_pass_daily_reward.json",
    "mission_pass_week_reward.json",
    "mission_pass_event_reward.json",
    "pass_card_event.json",
    "pass_card_reward.json",
    "raid_event.json",
    "reward_campaign.json",
    "story_join_character.json",
]

function installBundledGameplaySnapshot({
    onRestore,
    tableOverrides = {},
    additionalTableNames = [],
} = {}) {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const characterTable = deepFreeze(structuredClone(
        require(path.join(projectRoot, "assets", CHARACTER_TABLE_NAME))
    ))
    const characterContentTable = deepFreeze(structuredClone(
        require(path.join(projectRoot, "assets", CHARACTER_CONTENT_TABLE_NAME))
    ))
    const gameplayTables = Object.fromEntries(
        [...REWARD_TABLE_NAMES, ...QUEST_TABLE_NAMES, ...GAMEPLAY_DYNAMIC_TABLE_NAMES, ...additionalTableNames]
            .map(tableName => [
        tableName,
        deepFreeze(structuredClone(
            Object.prototype.hasOwnProperty.call(tableOverrides, tableName)
                ? tableOverrides[tableName]
                : require(path.join(projectRoot, "assets", tableName)),
        )),
        ]),
    )
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
            if (tableName in gameplayTables) return gameplayTables[tableName]
            throw new Error(`unexpected gameplay table ${tableName}`)
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

module.exports = { installBundledGameplaySnapshot }
