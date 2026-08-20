"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    admitMultiSnapshotReport,
    createMultiSnapshotReport,
    runMultiSnapshotBaseline,
} = require("./multi_snapshot_baseline.cjs")

test("creates a deterministic multiplayer snapshot baseline report", async () => {
    const report = await runMultiSnapshotBaseline({
        scenarioLoader: () => [
            {
                name: "full_unique",
                run: async () => ({
                    calls: {
                        character: 18,
                        equipment: 9,
                        manaNode: 18,
                        partyGroup: 2,
                        playerContext: 1,
                    },
                    outputSignature: "full-signature",
                    sqlSelectStatements: 0,
                }),
            },
            {
                name: "repeated_assets",
                run: async () => ({
                    calls: {
                        character: 18,
                        equipment: 9,
                        manaNode: 18,
                        partyGroup: 2,
                        playerContext: 1,
                    },
                    outputSignature: "repeat-signature",
                    sqlSelectStatements: 0,
                }),
            },
        ],
    })

    assert.deepEqual(report, {
        schemaVersion: 1,
        scenarios: {
            full_unique: {
                calls: {
                    character: 18,
                    equipment: 9,
                    manaNode: 18,
                    partyGroup: 2,
                    playerContext: 1,
                    total: 48,
                },
                outputSignature: "full-signature",
                sqlSelectStatements: 0,
            },
            repeated_assets: {
                calls: {
                    character: 18,
                    equipment: 9,
                    manaNode: 18,
                    partyGroup: 2,
                    playerContext: 1,
                    total: 48,
                },
                outputSignature: "repeat-signature",
                sqlSelectStatements: 0,
            },
        },
    })
})

test("rejects duplicate, malformed, or negative snapshot scenarios", async () => {
    await assert.rejects(() => runMultiSnapshotBaseline({
        scenarioLoader: () => [
            { name: "duplicate", run: async () => ({ calls: {}, outputSignature: "a" }) },
            { name: "duplicate", run: async () => ({ calls: {}, outputSignature: "b" }) },
        ],
    }), /duplicate multiplayer snapshot scenario/)

    assert.throws(() => createMultiSnapshotReport({
        invalid: {
            calls: {
                character: -1,
                equipment: 0,
                manaNode: 0,
                partyGroup: 0,
                playerContext: 0,
            },
            outputSignature: "invalid",
        },
    }), /character must be a non-negative safe integer/)

    assert.throws(() => createMultiSnapshotReport({
        invalid: {
            calls: {
                character: 0,
                equipment: 0,
                manaNode: 0,
                partyGroup: 0,
                playerContext: 0,
            },
            outputSignature: "",
        },
    }), /outputSignature must be a non-empty string/)
})

test("runs dependency and production SQLite snapshot scenarios", async () => {
    const report = await runMultiSnapshotBaseline()

    assert.deepEqual(Object.keys(report.scenarios), [
        "full_unique",
        "repeated_assets",
        "sqlite_full_unique",
        "sqlite_repeated_assets",
    ])
    for (const scenario of Object.values(report.scenarios)) {
        assert.deepEqual(scenario.calls, {
            character: 18,
            equipment: 9,
            manaNode: 18,
            partyGroup: 2,
            playerContext: 1,
            total: 48,
        })
        assert.match(scenario.outputSignature, /^sha256:[a-f0-9]{64}$/)
    }
    assert.equal(report.scenarios.full_unique.sqlSelectStatements, 0)
    assert.equal(report.scenarios.repeated_assets.sqlSelectStatements, 0)
    assert.ok(report.scenarios.sqlite_full_unique.sqlSelectStatements > 0)
    assert.ok(report.scenarios.sqlite_repeated_assets.sqlSelectStatements > 0)
    assert.notEqual(
        report.scenarios.full_unique.outputSignature,
        report.scenarios.repeated_assets.outputSignature,
    )
})

test("admits stable or lower read counts and rejects output or query regressions", async () => {
    const current = await runMultiSnapshotBaseline()
    assert.deepEqual(admitMultiSnapshotReport(current), { admitted: true, failures: [] })

    const improved = structuredClone(current)
    improved.scenarios.repeated_assets.calls.character = 1
    improved.scenarios.repeated_assets.calls.manaNode = 1
    improved.scenarios.repeated_assets.calls.equipment = 1
    improved.scenarios.repeated_assets.calls.total = 5
    assert.deepEqual(admitMultiSnapshotReport(improved), { admitted: true, failures: [] })

    const changedOutput = structuredClone(current)
    changedOutput.scenarios.full_unique.outputSignature = `sha256:${"0".repeat(64)}`
    assert.equal(admitMultiSnapshotReport(changedOutput).admitted, false)

    const regressed = structuredClone(current)
    regressed.scenarios.full_unique.calls.character++
    regressed.scenarios.full_unique.calls.total++
    assert.equal(admitMultiSnapshotReport(regressed).admitted, false)
})
