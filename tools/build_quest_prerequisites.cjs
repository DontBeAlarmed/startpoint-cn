#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const { buildQuestPrerequisites } = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.resolve(projectRoot, "../wf-assets-cn/orderedmap/quest")
const outputPath = path.resolve(projectRoot, "assets/quest_prerequisites.json")

// The extractor JSON in wf-assets already has the CsvOrderedMapTree shape.
function readTree(relative) {
    const filePath = path.join(sourceRoot, relative)
    if (!fs.existsSync(filePath)) {
        throw new Error(`CN quest source not found: ${filePath}`)
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

const table = buildQuestPrerequisites(
    {
        "main_quest.json": readTree("main_quest.json"),
        "ex_quest.json": readTree("ex_quest.json"),
    },
    {
        "main_quest.json": readTree("main_stage_node.json"),
        "ex_quest.json": readTree("ex_stage_node.json"),
    },
)

fs.writeFileSync(outputPath, `${JSON.stringify(table, null, 4)}\n`)
process.stdout.write(`wrote ${Object.keys(table).length} prerequisite entries to ${outputPath}\n`)
