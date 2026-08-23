"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
} = require("./awake_request_context_report.cjs")
const {
    runAwakeRequestContextBaseline,
} = require("./awake_request_context_baseline.cjs")

function createRuntimeHarness({ closeError = null } = {}) {
    let database = null
    let contentRestored = false
    const computer = { compute: () => 7 }
    const runtime = {
        closeDatabase() {
            if (closeError !== null) throw closeError
            if (database?.open) database.close()
        },
        getComputer: () => computer,
        getDatabaseStatus: () => ({ open: false, ready: false, schema: null }),
        getTimeOffset: () => 12345,
        initializeDatabase({ databaseFactory }) {
            database = databaseFactory(":memory:")
            return database
        },
        installBundledGameplaySnapshot() {
            return () => { contentRestored = true }
        },
        resolveRuntimeDataPaths: () => ({}),
        setServerTimeOffset() {},
    }
    return {
        computer,
        get contentRestored() { return contentRestored },
        get database() { return database },
        runtime,
    }
}

function createScenarios(execute) {
    return AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => ({
        name,
        prepare: () => null,
        execute,
        summarize: () => ({ stable: true }),
    }))
}

test("measureTarget scopes SQL and mission computes to the target operation", async () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-target-scope-"))
    const harness = createRuntimeHarness()
    try {
        const report = await runAwakeRequestContextBaseline({
            runtimeLoader: () => harness.runtime,
            scenarioFactory: () => createScenarios((_fixture, measureTarget) => {
                harness.database.prepare("SELECT 7 AS value").get()
                harness.computer.compute()
                const result = measureTarget(() => {
                    harness.database.prepare("SELECT 7 AS value").get()
                    harness.computer.compute()
                    return true
                })
                harness.database.prepare("SELECT 7 AS value").get()
                harness.computer.compute()
                return result
            }),
            temporaryParent,
        })
        for (const scenario of Object.values(report.scenarios)) {
            assert.equal(scenario.sqlReads, 1)
            assert.equal(scenario.sqlWrites, 0)
            assert.equal(scenario.missionComputes, 1)
            assert.deepEqual(scenario.sqlByTable, {})
        }
        assert.equal(harness.contentRestored, true)
        assert.equal(harness.database.open, false)
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("runner rejects zero or repeated measureTarget calls and still cleans resources", async () => {
    for (const callCount of [0, 2]) {
        const temporaryParent = fs.mkdtempSync(
            path.join(os.tmpdir(), `awake-target-count-${callCount}-`),
        )
        const harness = createRuntimeHarness()
        try {
            await assert.rejects(
                runAwakeRequestContextBaseline({
                    runtimeLoader: () => harness.runtime,
                    scenarioFactory: () => createScenarios((_fixture, measureTarget) => {
                        for (let index = 0; index < callCount; index++) {
                            measureTarget(() => true)
                        }
                        return true
                    }),
                    temporaryParent,
                }),
                /must call measureTarget exactly once/,
                `callCount=${callCount}`,
            )
            assert.equal(harness.contentRestored, true, `callCount=${callCount}`)
            assert.equal(harness.database.open, false, `callCount=${callCount}`)
            assert.deepEqual(fs.readdirSync(temporaryParent), [], `callCount=${callCount}`)
        } finally {
            fs.rmSync(temporaryParent, { recursive: true, force: true })
        }
    }
})

test("runner preserves non-Error primary failures together with cleanup failures", async () => {
    for (const primaryFailure of ["string primary failure", { kind: "object-primary" }]) {
        const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-non-error-"))
        const cleanupFailure = new Error("injected non-Error cleanup failure")
        const harness = createRuntimeHarness({ closeError: cleanupFailure })
        let caught
        try {
            try {
                await runAwakeRequestContextBaseline({
                    runtimeLoader: () => harness.runtime,
                    scenarioFactory: () => createScenarios((_fixture, measureTarget) => (
                        measureTarget(() => { throw primaryFailure })
                    )),
                    temporaryParent,
                })
            } catch (error) {
                caught = error
            }

            assert.equal(caught instanceof AggregateError, true)
            assert.equal(caught.errors.some(error => (
                error instanceof Error && error.cause === primaryFailure
            )), true)
            assert.equal(caught.errors.includes(cleanupFailure), true)
            assert.equal(harness.contentRestored, true)
            assert.equal(harness.database.open, false)
            assert.deepEqual(fs.readdirSync(temporaryParent), [])
        } finally {
            fs.rmSync(temporaryParent, { recursive: true, force: true })
        }
    }
})
