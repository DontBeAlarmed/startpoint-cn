"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const reference = require("./__snapshots__/mission_entry_layered_load_reference.json")
const {
    runMissionEntryLayeredLoad,
} = require("./mission_entry_layered_load.cjs")

test("layered mission entry smoke admits all four boundaries against BASE", async () => {
    assert.equal(reference.runtimeCommit, "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32")
    const report = await runMissionEntryLayeredLoad({
        players: 4,
        concurrencies: [1],
        reference,
    })

    assert.deepEqual(report.gate, {
        zeroErrors: true,
        behaviorEquivalent: true,
        rollbackVerified: true,
        sqlComputeNonIncreasing: true,
        admitted: true,
    })
    assert.equal(report.playerPool.preparedIndependentStates, 4)
    assert.equal(report.steps[0].requests, 4)
    for (const entry of Object.keys(reference.entries)) {
        assert.equal(report.steps[0].entries[entry].requests, 1)
        assert.equal(report.steps[0].entries[entry].errors, 0)
    }
})
