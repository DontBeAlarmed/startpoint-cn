#!/usr/bin/env node
"use strict"

/**
 * Regenerate the bundled Raid quest table from the CN OrderedMap extractor
 * using the same quest converter as content:sync.
 */

const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const {
    convertQuestTree,
} = require("../src/content/converters/quest")

const projectRoot = path.resolve(__dirname, "..")
const sourcePath = path.resolve(
    projectRoot,
    "../wf-assets-cn/orderedmap/quest/event/raid_event_quest.json",
)
const outputPath = path.resolve(projectRoot, "assets/raid_event_quest.json")

if (!fs.existsSync(sourcePath)) {
    throw new Error(`CN Raid quest source not found: ${sourcePath}`)
}

const sourceTree = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
const table = convertQuestTree("raid_event_quest.json", sourceTree)
const datedCount = Object.values(table).filter(quest => (
    quest.availableFromMs !== null && quest.availableUntilMs !== null
)).length

if (datedCount !== Object.keys(table).length) {
    throw new Error(
        `expected every bundled Raid quest to have a complete time window: ${datedCount}/${Object.keys(table).length}`,
    )
}

fs.writeFileSync(outputPath, `${JSON.stringify(table, null, 4)}\n`)
process.stdout.write(
    `wrote ${Object.keys(table).length} Raid quest entries with time windows to ${outputPath}\n`,
)
