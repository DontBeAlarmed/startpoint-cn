#!/usr/bin/env node
"use strict"

const path = require("node:path")

const { runGitObjectCollector } = require("./git-object-runtime.cjs")

const BASE_COMMIT = "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32"
const projectRoot = path.resolve(__dirname, "../..")

if (process.argv.length !== 2) {
    throw new Error("fixed mission entry BASE generator does not accept arguments")
}

process.stdout.write(runGitObjectCollector({
    collectorPath: path.join(__dirname, "mission_entry_load_base_collector.cjs"),
    expectedCommit: BASE_COMMIT,
    projectRoot,
}))
