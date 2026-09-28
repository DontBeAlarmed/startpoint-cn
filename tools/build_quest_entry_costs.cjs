#!/usr/bin/env node
"use strict"

/**
 * Regenerate the bundled assets/quest_entry_costs.json from the CN CDN
 * quest sources using the same buildQuestEntryCosts converter that
 * content:sync derives the runtime table from (single source of truth).
 *
 * Run after any quest table joins QUEST_TABLE_SOURCES or a CDN catalog
 * update changes entry costs; the bundled artifact is the offline fallback
 * for environments that have not run content:sync.
 */

const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const {
    buildQuestEntryCosts,
    QUEST_TABLE_SOURCES,
} = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.resolve(projectRoot, "../wf-assets-cn/orderedmap")
const outputPath = path.resolve(projectRoot, "assets/quest_entry_costs.json")

// The extractor JSON in wf-assets already has the CsvOrderedMapTree shape;
// logical paths like "master/quest/main_quest.orderedmap" map onto it.
function readTree(logicalPath) {
    const relative = logicalPath.replace(/^master\//, "").replace(/\.orderedmap$/, ".json")
    const filePath = path.join(sourceRoot, relative)
    if (!fs.existsSync(filePath)) {
        throw new Error(`CN quest source not found: ${filePath}`)
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

const trees = {}
for (const [tableName, source] of Object.entries(QUEST_TABLE_SOURCES)) {
    trees[tableName] = readTree(source.logicalPath)
}

const table = buildQuestEntryCosts(trees)

fs.writeFileSync(outputPath, JSON.stringify(table))
process.stdout.write(`wrote ${Object.keys(table).length} entry-cost entries to ${outputPath}\n`)
