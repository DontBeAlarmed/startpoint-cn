"use strict"

const BUNDLED_TABLE_NAMES = new Set([
    "mission_regular.json", "mission_daily.json", "mission_event.json",
    "mission_collect_item.json", "mission_degree.json", "mission_pass_daily.json",
    "mission_pass_week.json", "mission_pass_event.json", "mission_char_awake.json",
    "mission_weekly_def.json", "mission_regular_reward.json", "mission_daily_reward.json",
    "mission_event_reward.json", "mission_collect_item_reward.json",
    "mission_degree_reward.json", "mission_pass_daily_reward.json",
    "mission_pass_week_reward.json", "mission_pass_event_reward.json",
    "mission_char_awake_reward.json", "mission_weekly_reward.json", "character.json",
    "character_quest_lookup.json", "mana_board.json", "config.json", "main_quest.json",
    "ex_quest.json", "treasure_shop.json", "boss_battle_quest.json",
    "expert_single_event_quest.json", "world_story_event_quest.json",
    "world_story_event_boss_battle_quest.json", "advent_event_quest.json",
    "carnival_event_quest.json", "hard_multi_event_quest.json",
    "challenge_dungeon_event_quest.json", "ranking_event_single_quest.json",
    "rush_event_quest.json", "cdndata/player_rank_full.json",
    "mission_event_battle_rules.json",
    "mission_event_quest_map.json", "equipment_dissolve.json", "item_sale.json",
])

const bundledInfo = Object.freeze({
    source: "bundled",
    assetVersion: "mission-catalog",
    generatorVersion: 0,
    releaseDigest: null,
    contentDigest: "sha256:mission-catalog",
    multiBattleContentDigest: "sha256:mission-catalog",
})

const bundledMissionContentRepository = Object.freeze({
    info: () => bundledInfo,
    table(tableName) {
        if (!BUNDLED_TABLE_NAMES.has(tableName)) {
            throw new Error(`unsupported bundled mission table: ${tableName}`)
        }
        return require(`../../assets/${tableName}`)
    },
})

module.exports = { bundledMissionContentRepository }
