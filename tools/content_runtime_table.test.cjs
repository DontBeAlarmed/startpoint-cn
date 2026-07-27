"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    getRuntimeContentTableSync,
} = require("../src/content/runtime/table-access")

test("runtime table access prefers the installed snapshot", () => {
    const previous = productionContentSnapshotProvider.snapshot
    const dynamic = Object.freeze({ source: "dynamic" })
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "1.4.55" },
        repository: { table: tableName => {
            assert.equal(tableName, "quest_entry_costs.json")
            return dynamic
        } },
    }
    try {
        assert.equal(
            getRuntimeContentTableSync("quest_entry_costs.json", { source: "bundled" }),
            dynamic,
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
})

test("runtime table access only falls back before snapshot initialization", () => {
    const previous = productionContentSnapshotProvider.snapshot
    const bundled = Object.freeze({ source: "bundled" })
    productionContentSnapshotProvider.snapshot = null
    try {
        assert.equal(getRuntimeContentTableSync("quest_lookup.json", bundled), bundled)
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }

    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "1.4.55" },
        repository: { table: () => { throw new Error("damaged release") } },
    }
    try {
        assert.throws(
            () => getRuntimeContentTableSync("quest_lookup.json", bundled),
            /damaged release/,
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
})
