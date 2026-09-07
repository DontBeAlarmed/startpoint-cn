"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const bundledMissionFiles = [
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
    "rush_event_quest.json", "equipment_dissolve.json", "item_sale.json",
]

test("loading Mission Catalog does not eagerly load its bundled raw tables", () => {
    const script = [
        "require('ts-node/register/transpile-only')",
        "require('./src/lib/mission/mission-catalog')",
        "process.stdout.write(JSON.stringify(Object.keys(require.cache)))",
    ].join(";")
    const result = spawnSync(process.execPath, ["-e", script], {
        cwd: projectRoot,
        encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    const loaded = JSON.parse(result.stdout).filter(filePath => (
        bundledMissionFiles.some(fileName => filePath.endsWith(`/assets/${fileName}`))
    ))
    assert.deepEqual(loaded, [])
})
