"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
    createAwakeRequestContextReport,
} = require("./awake_request_context_report.cjs")
const {
    admitAwakeRequestContextReport,
    parseArgs,
    runAwakeRequestContextBaseline,
    writeAwakeRequestContextSnapshotAtomic,
} = require("./awake_request_context_baseline.cjs")
const {
    createAwakeRequestContextScenarios,
} = require("./awake_request_context_scenarios.cjs")

const snapshotPath = path.join(
    __dirname,
    "__snapshots__",
    "awake_request_context_baseline.json",
)

function createScenario() {
    return {
        sqlReads: 2,
        sqlWrites: 1,
        missionComputes: 1,
        sqlByTable: {
            players_character_awake_unlocks: { reads: 1, writes: 1, statements: 2 },
        },
        behavior: { stable: true },
    }
}

function createReport() {
    return createAwakeRequestContextReport(Object.fromEntries(
        AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
    ))
}

test("CLI accepts only the explicit snapshot write switch", () => {
    assert.deepEqual(parseArgs([]), { write: false })
    assert.deepEqual(parseArgs(["--write"]), { write: true })
    assert.throws(() => parseArgs(["--update"]), /unknown argument/)
    assert.throws(() => parseArgs(["--write", "extra"]), /unknown argument/)
})

test("ordinary admission is read-only and only explicit write creates a snapshot", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-admit-"))
    const target = path.join(temporaryParent, "snapshot.json")
    const report = createReport()
    try {
        assert.throws(
            () => admitAwakeRequestContextReport(report, { snapshotPath: target }),
            /ENOENT|snapshot/i,
        )
        assert.equal(fs.existsSync(target), false)

        const created = admitAwakeRequestContextReport(report, {
            snapshotPath: target,
            write: true,
        })
        assert.equal(created.admitted, true)
        const original = fs.readFileSync(target, "utf8")

        const improved = structuredClone(report)
        improved.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].sqlReads--
        const readOnly = admitAwakeRequestContextReport(improved, {
            snapshotPath: target,
            write: false,
        })
        assert.equal(readOnly.admitted, true)
        assert.equal(fs.readFileSync(target, "utf8"), original)

        const written = admitAwakeRequestContextReport(improved, {
            snapshotPath: target,
            write: true,
        })
        assert.equal(written.admitted, true)
        assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), improved)

        fs.writeFileSync(target, original)
        const behaviorChanged = structuredClone(report)
        behaviorChanged.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]]
            .behavior.stable = false
        const rejected = admitAwakeRequestContextReport(behaviorChanged, {
            snapshotPath: target,
            write: true,
        })
        assert.equal(rejected.admitted, false)
        assert.equal(fs.readFileSync(target, "utf8"), original)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("snapshot writer replaces atomically and removes failed temporary files", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-write-"))
    const target = path.join(temporaryParent, "snapshot.json")
    const temporary = path.join(temporaryParent, ".snapshot.test.tmp")
    const report = createReport()
    fs.writeFileSync(target, "checked\n")
    try {
        writeAwakeRequestContextSnapshotAtomic(report, target, {
            temporaryPathFactory: () => temporary,
        })
        assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), report)
        assert.equal(fs.existsSync(temporary), false)

        for (const failingOperation of ["write", "rename"]) {
            fs.writeFileSync(target, "checked\n")
            const fileSystem = {
                writeFileSync(...args) {
                    if (failingOperation === "write") {
                        fs.writeFileSync(args[0], "partial", "utf8")
                        throw new Error("injected write failure")
                    }
                    return fs.writeFileSync(...args)
                },
                renameSync(...args) {
                    if (failingOperation === "rename") {
                        throw new Error("injected rename failure")
                    }
                    return fs.renameSync(...args)
                },
                rmSync: (...args) => fs.rmSync(...args),
            }
            assert.throws(
                () => writeAwakeRequestContextSnapshotAtomic(report, target, {
                    fileSystem,
                    temporaryPathFactory: () => temporary,
                }),
                new RegExp(`injected ${failingOperation} failure`),
            )
            assert.equal(fs.readFileSync(target, "utf8"), "checked\n")
            assert.equal(fs.existsSync(temporary), false)
        }
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("snapshot writer rejects a forged canonical marker", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-forged-"))
    const target = path.join(temporaryParent, "snapshot.json")
    try {
        const report = createReport()
        const marker = Reflect.ownKeys(report).find(key => typeof key === "symbol")
        const forged = { version: report.version }
        Object.defineProperty(forged, marker, { value: true })

        assert.throws(
            () => writeAwakeRequestContextSnapshotAtomic(forged, target),
            /snapshot-write|fields|scenario/i,
        )
        assert.equal(fs.existsSync(target), false)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("snapshot writer revalidates a canonical report modified after creation", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-mutated-"))
    const target = path.join(temporaryParent, "snapshot.json")
    try {
        const report = createReport()
        report.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].behavior.stable = false

        assert.throws(
            () => writeAwakeRequestContextSnapshotAtomic(report, target),
            /behavior hash|hash mismatch/i,
        )
        assert.equal(fs.existsSync(target), false)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("snapshot writer rejects getters without invoking them", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-getter-"))
    const target = path.join(temporaryParent, "snapshot.json")
    let getterCalls = 0
    try {
        const report = createReport()
        Object.defineProperty(
            report.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]],
            "sqlReads",
            {
                enumerable: true,
                get() {
                    getterCalls++
                    return 2
                },
            },
        )

        assert.throws(
            () => writeAwakeRequestContextSnapshotAtomic(report, target),
            /enumerable data value/i,
        )
        assert.equal(getterCalls, 0)
        assert.equal(fs.existsSync(target), false)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("snapshot writer rejects Proxy reports", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-proxy-"))
    const target = path.join(temporaryParent, "snapshot.json")
    try {
        const report = new Proxy(createReport(), {})

        assert.throws(
            () => writeAwakeRequestContextSnapshotAtomic(report, target),
            /Proxy/,
        )
        assert.equal(fs.existsSync(target), false)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

function createFailureScenarioRuntime(overrides) {
    return {
        getDb: () => ({
            prepare: () => ({ run() {} }),
            transaction: operation => () => operation(),
        }),
        ...overrides,
    }
}

test("strict failure scenario rethrows errors outside the injected unlock write", () => {
    const runtime = createFailureScenarioRuntime({
        reconcileAwakeUnlockCharacterListStrict() {
            throw new Error("unexpected strict publication failure")
        },
    })
    const scenario = createAwakeRequestContextScenarios(runtime)
        .find(entry => entry.name === "strict-failure-rollback")

    assert.throws(
        () => scenario.execute({ playerId: 1 }, operation => operation()),
        /unexpected strict publication failure/,
    )
})

test("best-effort failure scenario requires the injected Error in console output", () => {
    const runtime = createFailureScenarioRuntime({
        reconcileAwakeUnlockCharacterListBestEffort(_playerId, existing) {
            console.error("unexpected publication log", new Error("different failure"))
            return existing
        },
    })
    const scenario = createAwakeRequestContextScenarios(runtime)
        .find(entry => entry.name === "best-effort-failure")

    assert.throws(
        () => scenario.execute({ playerId: 1 }, operation => operation()),
        /injected awake unlock write failure/i,
    )
})

test("runner restores database, Content, time, console, and temporary files after failure", async () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-cleanup-"))
    const originalLog = console.log
    const originalError = console.error
    const timeOffsets = []
    let contentRestoreAttempted = false
    let database
    const computer = { compute: () => 0 }
    const runtime = {
        closeDatabase() { throw new Error("injected shared database close failure") },
        getComputer: () => computer,
        getDatabaseStatus: () => ({ open: false, ready: false, schema: null }),
        getTimeOffset: () => 12345,
        initializeDatabase({ databaseFactory }) {
            database = databaseFactory(":memory:")
            return database
        },
        installBundledGameplaySnapshot() {
            return () => {
                contentRestoreAttempted = true
                throw new Error("injected Content restore failure")
            }
        },
        resolveRuntimeDataPaths: () => ({}),
        setServerTimeOffset(value) {
            timeOffsets.push(value)
            if (value === 12345) throw new Error("injected time restore failure")
        },
    }
    const scenarioFactory = () => AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => ({
        name,
        prepare: () => 1,
        execute(_fixture, measureTarget) {
            return measureTarget(() => {
                throw new Error("injected Awake scenario failure")
            })
        },
        summarize: () => ({}),
    }))

    try {
        await assert.rejects(
            runAwakeRequestContextBaseline({
                runtimeLoader: () => runtime,
                scenarioFactory,
                temporaryParent,
            }),
            /injected Awake scenario failure/,
        )
        assert.equal(database.open, false, "fallback database close must run")
        assert.equal(contentRestoreAttempted, true)
        assert.equal(timeOffsets.at(-1), 12345, "time restore must still be attempted")
        assert.equal(console.log, originalLog)
        assert.equal(console.error, originalError)
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        console.log = originalLog
        console.error = originalError
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("runner refuses to share an already open database", async () => {
    const originalLog = console.log
    const originalError = console.error
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "awake-context-open-db-"))
    try {
        await assert.rejects(
            runAwakeRequestContextBaseline({
                runtimeLoader: () => ({
                    getDatabaseStatus: () => ({ open: true, ready: true, schema: 7 }),
                }),
                temporaryParent,
            }),
            /refuses to run while the shared database is open/,
        )
        assert.equal(console.log, originalLog)
        assert.equal(console.error, originalError)
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        console.log = originalLog
        console.error = originalError
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("current publication and reconcile baseline matches the checked snapshot", async () => {
    assert.equal(fs.existsSync(snapshotPath), true, "Awake request-context snapshot must exist")
    const report = await runAwakeRequestContextBaseline()
    assert.deepEqual(Object.keys(report.scenarios), AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS)
    assert.deepEqual(
        report.scenarios["full-publication"].behavior.persistedUnlocks,
        [[341005, [[1, 1]]]],
    )
    assert.deepEqual(
        report.scenarios["full-publication"].behavior.characterList.map(character => ({
            join_time: character.join_time,
            update_time: character.update_time,
        })),
        [{
            join_time: "2025-01-01 12:00:00",
            update_time: "2025-01-01 12:00:00",
        }],
    )
    assert.deepEqual(
        report.scenarios["candidate-one"].behavior.first.changed,
        [[341005, [[1, 1]]]],
    )
    assert.deepEqual(report.scenarios["candidate-one"].behavior.second.changed, [])
    assert.deepEqual(
        report.scenarios["empty-candidate-cleanup"].behavior.removed,
        [[341005, [[1, 1]]]],
    )
    assert.deepEqual(report.scenarios["empty-candidate-cleanup"].behavior.finalUnlocks, [])
    assert.deepEqual(report.scenarios["strict-failure-rollback"].behavior, {
        candidateUnlockPresent: false,
        errorCategory: "database-write-failure",
        injectedFailureObserved: true,
        ownerDelta: 0,
        staleUnlockPreserved: true,
        threw: true,
        unlockCount: 1,
    })
    assert.deepEqual(report.scenarios["best-effort-failure"].behavior, {
        candidateUnlockPresent: false,
        errorLogged: true,
        injectedFailureObserved: true,
        ownerDelta: 7,
        returnedExistingIdentity: true,
        staleUnlockPreserved: true,
        unlockCount: 1,
    })
    for (const name of ["strict-failure-rollback", "best-effort-failure"]) {
        assert.equal(report.scenarios[name].sqlWrites, 2, name)
        assert.equal(report.scenarios[name].sqlByTable.players.writes, 0, name)
        assert.equal(
            report.scenarios[name].sqlByTable.players.statements,
            report.scenarios[name].sqlByTable.players.reads,
            name,
        )
    }
    const admission = admitAwakeRequestContextReport(report, {
        snapshotPath,
        write: false,
    })
    assert.equal(admission.admitted, true, JSON.stringify(admission.failures, null, 2))
})
