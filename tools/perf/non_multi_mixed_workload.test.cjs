"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const workloadPath = path.join(__dirname, "non_multi_mixed_workload.cjs")
const workload = fs.existsSync(workloadPath) ? require(workloadPath) : {}
const {
    createAdmissionGate,
    validateReportStructure,
} = require("./non_multi_mixed_metrics.cjs")

function requireParseArgs() {
    assert.equal(typeof workload.parseArgs, "function", "workload must export parseArgs")
    return workload.parseArgs
}

test("parseArgs defaults to the seven-request smoke profile", () => {
    const parseArgs = requireParseArgs()
    assert.deepEqual(parseArgs([]), {
        formal: false,
        output: null,
        profile: {
            independentSaves: 7,
            activeIdentities: 7,
            concurrencySteps: [2],
        },
    })
})

test("parseArgs exposes only the locked formal profile", () => {
    const parseArgs = requireParseArgs()
    assert.deepEqual(parseArgs(["--formal"]), {
        formal: true,
        output: null,
        profile: {
            independentSaves: 1000,
            activeIdentities: 600,
            concurrencySteps: [10, 25, 50, 100],
        },
    })
})

test("parseArgs accepts an output path without changing the smoke profile", () => {
    const parseArgs = requireParseArgs()
    assert.deepEqual(parseArgs(["--output", "reports/mixed.json"]), {
        formal: false,
        output: "reports/mixed.json",
        profile: {
            independentSaves: 7,
            activeIdentities: 7,
            concurrencySteps: [2],
        },
    })
})

test("parseArgs rejects unknown, duplicate formal, and missing output arguments", () => {
    const parseArgs = requireParseArgs()
    assert.throws(() => parseArgs(["--players", "7"]), /unknown argument: --players/)
    assert.throws(() => parseArgs(["--formal", "--formal"]), /--formal may only be specified once/)
    assert.throws(() => parseArgs(["--output"]), /--output requires a path/)
    assert.throws(() => parseArgs(["--output", "--formal"]), /--output requires a path/)
})

test("package script runs the smoke workload unless formal is explicit", () => {
    const packageJson = require("../../package.json")
    assert.equal(
        packageJson.scripts["benchmark:non-multi-mixed"],
        "node tools/perf/non_multi_mixed_workload.cjs",
    )
})

test("loading the workload is silent before report execution", () => {
    const result = spawnSync(
        process.execPath,
        ["-e", "require(process.argv[1])", workloadPath],
        { encoding: "utf8" },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
})

test("behavior signatures omit identity, seed, and time fields", () => {
    assert.equal(typeof workload.behaviorSignature, "function")
    const first = workload.behaviorSignature({
        viewerId: 1,
        seed: 123,
        time: "2024-08-14T12:00:00.000Z",
        result: { value: 4 },
    })
    const second = workload.behaviorSignature({
        viewerId: 2,
        seed: 456,
        time: "2024-08-15T12:00:00.000Z",
        result: { value: 4 },
    })
    assert.equal(first, second)
})

test("smoke executes all seven entries, attributes SQL, and cleans its root", async () => {
    assert.equal(typeof workload.runNonMultiMixedWorkload, "function")
    const parent = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "non-multi-mixed-test-"))
    const consoleMethods = ["error", "info", "log", "warn"]
    const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]]))
    const observedConsole = []
    for (const name of consoleMethods) {
        console[name] = (...args) => { observedConsole.push([name, ...args]) }
    }
    try {
        const report = await workload.runNonMultiMixedWorkload({
            temporaryParent: parent,
            profile: {
                independentSaves: 7,
                activeIdentities: 7,
                concurrencySteps: [2],
            },
        })
        assert.equal(validateReportStructure(report), true)
        assert.equal(createAdmissionGate(report).zeroErrors, true)
        assert.equal(report.gate.admitted, false)
        assert.equal(report.gate.rollbackVerified, true)
        assert.deepEqual(report.steps[0].entries.map(entry => entry.name), [
            "auth", "load", "mission-progress", "single-battle", "shop", "gacha", "mail",
        ])
        assert.deepEqual(report.steps[0].entries.map(entry => entry.requests), [1, 1, 1, 1, 1, 1, 1])
        assert.ok(report.steps[0].entries.every(entry => entry.sql.readsMax > 0))
        assert.deepEqual(
            report.steps[0].entries.filter(entry => ["single-battle", "shop", "gacha", "mail"].includes(entry.name))
                .map(entry => entry.rollbackVerified),
            [true, true, true, true],
        )
        assert.equal(fs.readdirSync(parent).length, 0)
    } finally {
        for (const name of consoleMethods) console[name] = originalConsole[name]
        fs.rmSync(parent, { recursive: true, force: true })
    }
    assert.deepEqual(observedConsole, [])
})

test("primary workload errors retain cleanup failures", async () => {
    const primaryFailure = new Error("seed setup failed")
    const cleanupFailure = new Error("database close failed")
    const restoreContentFailure = new Error("content restore failed")
    const restoreTimeFailure = new Error("time restore failed")
    let setTimeCalls = 0
    const fakeRuntime = {
        closeDatabase() {
            throw cleanupFailure
        },
        getDatabaseStatus() {
            return { open: false, ready: false }
        },
        getTimeOffset() {
            return 0
        },
        setServerTimeOffset() {
            setTimeCalls++
            if (setTimeCalls > 1) throw restoreTimeFailure
        },
        installBundledGameplaySnapshot() {
            return () => { throw restoreContentFailure }
        },
        resolveRuntimeDataPaths() {
            throw primaryFailure
        },
    }

    await assert.rejects(
        workload.runNonMultiMixedWorkload({
            runtime: fakeRuntime,
            profile: {
                independentSaves: 7,
                activeIdentities: 7,
                concurrencySteps: [2],
            },
        }),
        error => {
            assert.equal(error, primaryFailure)
            assert.ok(error.cause instanceof AggregateError)
            assert.deepEqual(error.cause.errors, [
                cleanupFailure,
                restoreContentFailure,
                restoreTimeFailure,
            ])
            return true
        },
    )
})

test("workload refuses an existing database without closing caller state", async () => {
    let closeCalls = 0
    const fakeRuntime = {
        closeDatabase() {
            closeCalls++
        },
        getDatabaseStatus() {
            return { open: true, ready: true }
        },
    }

    await assert.rejects(
        workload.runNonMultiMixedWorkload({
            runtime: fakeRuntime,
            profile: {
                independentSaves: 7,
                activeIdentities: 7,
                concurrencySteps: [2],
            },
        }),
        /requires the shared database to be closed/,
    )
    assert.equal(closeCalls, 0)
})

test("step copy failures remove the partially created run directory", async () => {
    const parent = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "non-multi-step-copy-"))
    const runDirectory = path.join(parent, "run")
    try {
        await assert.rejects(
            workload.runStep({
                runtime: { closeDatabase() {} },
                scenarioDependencies: {},
                seedDirectory: path.join(parent, "missing-seed"),
                runDirectory,
                pool: { activeIdentities: [] },
                mailFixtureByIdentity: {},
                concurrency: 1,
            }),
            /ENOENT/,
        )
        assert.equal(fs.existsSync(runDirectory), false)
    } finally {
        fs.rmSync(parent, { recursive: true, force: true })
    }
})
