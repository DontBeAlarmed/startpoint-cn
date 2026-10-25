#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const { buildBossBattleJoinGates } = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const sourcePath = path.resolve(projectRoot, "../wf-assets-cn/orderedmap/quest/boss_battle_quest.json")
const outputPath = path.resolve(projectRoot, "assets/boss_battle_join_gates.json")

const tree = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
const gates = buildBossBattleJoinGates(tree)
fs.writeFileSync(outputPath, `${JSON.stringify(gates, null, 4)}\n`)
process.stdout.write(`wrote ${Object.keys(gates).length} boss join-gate entries to ${outputPath}\n`)
