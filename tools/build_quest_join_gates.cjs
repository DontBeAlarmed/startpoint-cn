#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const { buildQuestJoinGates } = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const outputPath = path.resolve(projectRoot, "assets/quest_join_gates.json")

const sourceRoot = path.resolve(projectRoot, "../wf-assets-cn/orderedmap/quest")
const trees = {}
for (const tableName of [
    "advent_event_quest", "boss_battle_quest", "carnival_event_quest",
    "challenge_dungeon_event_quest", "character_quest", "daily_exp_mana_event_quest",
    "daily_week_event_quest", "ex_quest", "expert_single_event_quest",
    "hard_multi_event_quest", "main_quest", "practice_quest", "raid_event_quest",
    "ranking_event_single_quest", "rush_event_quest", "score_attack_event_quest",
    "solo_time_attack_event_quest", "story_event_single_quest",
    "tower_dungeon_event_quest", "world_story_event_boss_battle_quest",
    "world_story_event_quest",
]) {
    const p1 = path.join(sourceRoot, `${tableName}.json`)
    const p2 = path.join(sourceRoot, "event", `${tableName}.json`)
    const file = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null)
    if (file === null) continue // 无 CDN 视图的表（如 practice）无门数据，安全跳过
    trees[`${tableName}.json`] = JSON.parse(fs.readFileSync(file, "utf8"))
}
const gates = buildQuestJoinGates(trees)
fs.writeFileSync(outputPath, `${JSON.stringify(gates, null, 4)}\n`)
process.stdout.write(`wrote ${Object.keys(gates).length} table sections to ${outputPath}\n`)
