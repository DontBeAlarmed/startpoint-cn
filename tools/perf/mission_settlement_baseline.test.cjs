"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    FIXED_TIME,
    createSqlCounter,
    createStableSummary,
    parseArgs,
    runMissionSettlementBaseline,
    writeReport,
} = require("./mission_settlement_baseline.cjs")

const data = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")

const snapshotPath = path.join(
    __dirname,
    "__snapshots__",
    "mission_settlement_baseline.json",
)

test("validates mission settlement baseline arguments", () => {
    assert.deepEqual(parseArgs([]), {
        measurements: 5,
        output: null,
        warmups: 2,
    })
    assert.deepEqual(parseArgs([
        "--warmups", "0",
        "--measurements", "3",
        "--output", "report.json",
    ]), {
        measurements: 3,
        output: "report.json",
        warmups: 0,
    })
    assert.throws(() => parseArgs(["--warmups", "-1"]), /warmups must be a non-negative integer/)
    assert.throws(() => parseArgs(["--measurements", "0"]), /measurements must be a positive integer/)
    assert.throws(() => parseArgs(["--unknown", "1"]), /unknown argument/)
    assert.throws(() => parseArgs(["--output"]), /--output requires a value/)
})

test("classifies SQL totals, reads, writes, transactions, and touched tables", () => {
    const counter = createSqlCounter()
    counter.observe("SELECT p.id FROM players p JOIN players_items i ON i.player_id = p.id")
    counter.observe("INSERT INTO players_category_missions (player_id, mission_id) VALUES (1, 1)")
    counter.observe("UPDATE players SET free_vmoney = 10 WHERE id = 1")

    assert.deepEqual(counter.snapshot(), {
        statements: 3,
        selectStatements: 1,
        writeStatements: 2,
        transactionStatements: 0,
        byTable: {
            players: { statements: 2, reads: 1, writes: 1 },
            players_category_missions: { statements: 1, reads: 0, writes: 1 },
            players_items: { statements: 1, reads: 1, writes: 0 },
        },
    })
})

test("classifies conflict updates and delete self-reads without inventing tables", () => {
    const counter = createSqlCounter()
    counter.observe("UPDATE OR IGNORE players SET free_vmoney = 10 WHERE id = 1")
    counter.observe(`
        DELETE FROM players_items
        WHERE player_id IN (SELECT player_id FROM players_items JOIN players ON players.id = player_id)
    `)
    counter.observe("SELECT 'FROM fake_table' AS source FROM players")

    assert.deepEqual(counter.snapshot(), {
        statements: 3,
        selectStatements: 1,
        writeStatements: 2,
        transactionStatements: 0,
        byTable: {
            players: { statements: 3, reads: 2, writes: 1 },
            players_items: { statements: 1, reads: 1, writes: 1 },
        },
    })
})

test("classifies SQLite transaction control separately", () => {
    const counter = createSqlCounter()
    for (const sql of [
        "BEGIN IMMEDIATE",
        "SAVEPOINT mission_settlement",
        "SAVEPOINT ` _bs3. `",
        "ROLLBACK TO mission_settlement",
        "RELEASE mission_settlement",
        "COMMIT",
        "END",
    ]) counter.observe(sql)

    assert.deepEqual(counter.snapshot(), {
        statements: 7,
        selectStatements: 0,
        writeStatements: 0,
        transactionStatements: 7,
        byTable: {},
    })
})

test("rejects CTEs, leading comments, and unknown SQL instead of silently counting them", () => {
    const counter = createSqlCounter()
    assert.throws(() => counter.observe("WITH recent AS (SELECT id FROM players) SELECT * FROM recent"), /unsupported SQL/i)
    assert.throws(() => counter.observe("-- baseline\nSELECT id FROM players"), /unsupported SQL/i)
    assert.throws(() => counter.observe("PRAGMA user_version"), /unsupported SQL/i)
    assert.throws(() => counter.observe("UPDATE OR IGNORE SET value = 1"), /unsupported SQL/i)
    assert.deepEqual(counter.snapshot(), {
        statements: 0,
        selectStatements: 0,
        writeStatements: 0,
        transactionStatements: 0,
        byTable: {},
    })
})

test("accepts only SQLite trace truncation markers while classifying SELECT reads", () => {
    const counter = createSqlCounter()
    counter.observe(`
        SELECT counters.count
        FROM json_each('[[8,100001,"daily","2024-08-14"]'/*+2885 bytes*/) AS requested
        JOIN players_shop_purchase_counters AS counters
          ON counters.shop_item_id = json_extract(requested.value, '$[1]')
    `)

    assert.deepEqual(counter.snapshot(), {
        statements: 1,
        selectStatements: 1,
        writeStatements: 0,
        transactionStatements: 0,
        byTable: {
            json_each: { statements: 1, reads: 1, writes: 0 },
            players_shop_purchase_counters: { statements: 1, reads: 1, writes: 0 },
        },
    })
})

test("rejects comments that are not exact positive SQLite trace truncation markers", () => {
    const counter = createSqlCounter()
    for (const comment of [
        "/* comment */",
        "/*+ bytes*/",
        "/*+0 bytes*/",
        "/*+12 byte*/",
        "/*+12 BYTES*/",
        "/*++12 bytes*/",
        "-- trace truncation",
    ]) {
        assert.throws(
            () => counter.observe(`SELECT id FROM players ${comment}`),
            /unsupported SQL/i,
            comment,
        )
    }
    assert.deepEqual(counter.snapshot(), {
        statements: 0,
        selectStatements: 0,
        writeStatements: 0,
        transactionStatements: 0,
        byTable: {},
    })
})

test("stable summaries publish their complete payload and ignore run configuration", () => {
    const base = {
        version: 2,
        fixedTime: FIXED_TIME,
        warmups: 2,
        measurements: 2,
        scenarios: [{
            name: "new-account",
            latencyMs: { p50: 1.25, p95: 3.5 },
            sql: {
                statements: 1,
                selectStatements: 1,
                writeStatements: 0,
                transactionStatements: 0,
                byTable: { players: { statements: 1, reads: 1, writes: 0 } },
            },
            missions: {
                candidates: 10,
                computed: 4,
                progressChanged: 0,
                byCategory: {
                    "1": {
                        candidates: 10,
                        computed: 4,
                        progressChanged: 0,
                        rewardStagesGranted: 0,
                    },
                },
            },
            rewardStagesGranted: 0,
        }],
    }
    const alternateRun = structuredClone(base)
    alternateRun.warmups = 0
    alternateRun.measurements = 1
    alternateRun.scenarios[0].warmups = 0
    alternateRun.scenarios[0].measurements = 1
    alternateRun.scenarios[0].latencyMs = { p50: 999, p95: 1200 }

    const summary = createStableSummary(base)
    assert.deepEqual(summary, createStableSummary(alternateRun))
    assert.equal(summary.version, 2)
    assert.deepEqual(summary.scenarios[0].sql.byTable, base.scenarios[0].sql.byTable)
    assert.deepEqual(
        summary.scenarios[0].missions.byCategory,
        base.scenarios[0].missions.byCategory,
    )
    assert.equal(Object.hasOwn(summary, "warmups"), false)
    assert.equal(Object.hasOwn(summary, "measurements"), false)

    const { sha256, ...payload } = summary
    assert.equal(
        sha256,
        crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    )
})

test("refuses to run while the shared database is open and leaves it untouched", () => {
    const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-open-db-"))
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-guard-"))
    const paths = resolveRuntimeDataPaths({ DATA_DIR: path.join(databaseRoot, "data") })

    try {
        data.initializeDatabase({ paths })
        const before = {
            accounts: getDb().prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
            players: getDb().prepare("SELECT COUNT(*) AS count FROM players").get().count,
        }

        assert.throws(
            () => runMissionSettlementBaseline({
                measurements: 1,
                temporaryParent,
                warmups: 0,
            }),
            /mission settlement baseline refuses to run while the shared database is open/i,
        )
        assert.deepEqual({
            accounts: getDb().prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
            players: getDb().prepare("SELECT COUNT(*) AS count FROM players").get().count,
        }, before)
        assert.deepEqual(data.getDatabaseStatus(), { open: true, ready: true, schema: 20 })
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        data.closeDatabase()
        fs.rmSync(databaseRoot, { recursive: true, force: true })
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("cleans an already-created suite directory when dependency loading fails", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-load-fail-"))
    try {
        assert.throws(
            () => runMissionSettlementBaseline({
                measurements: 1,
                runtimeLoader() {
                    assert.equal(fs.readdirSync(temporaryParent).length, 1)
                    throw new Error("injected dependency failure")
                },
                temporaryParent,
                warmups: 0,
            }),
            /injected dependency failure/,
        )
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("cleans the database, suite directory, and time offset when scenario creation fails", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-create-fail-"))
    const originalOffset = 12345
    let currentOffset = originalOffset
    let databaseHandle
    let sharedCloseCalls = 0
    const runtime = {
        closeDatabase() {
            sharedCloseCalls++
            databaseHandle.close()
        },
        getDatabaseStatus() { return { open: false, ready: false, schema: null } },
        getTimeOffset() { return currentOffset },
        initializeDatabase() {
            databaseHandle = {
                open: true,
                close() { this.open = false },
            }
            return databaseHandle
        },
        resolveRuntimeDataPaths() { return {} },
        setServerTimeOffset(value) { currentOffset = value },
        settleMissionCategories() { throw new Error("settlement should not run") },
        SCENARIOS: [{
            name: "create-failure",
            create() { throw new Error("injected scenario creation failure") },
        }],
    }

    try {
        assert.throws(
            () => runMissionSettlementBaseline({
                measurements: 1,
                runtimeLoader: () => runtime,
                temporaryParent,
                warmups: 0,
            }),
            /injected scenario creation failure/,
        )
        assert.equal(sharedCloseCalls, 1)
        assert.equal(databaseHandle.open, false)
        assert.equal(currentOffset, originalOffset)
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("preserves settlement failure while fallback-closing the database after close failure", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-close-fail-"))
    const originalOffset = 67890
    let currentOffset = originalOffset
    let databaseHandle
    const runtime = {
        closeDatabase() { throw new Error("injected shared close failure") },
        getDatabaseStatus() { return { open: false, ready: false, schema: null } },
        getTimeOffset() { return currentOffset },
        initializeDatabase() {
            databaseHandle = {
                open: true,
                close() { this.open = false },
            }
            return databaseHandle
        },
        resolveRuntimeDataPaths() { return {} },
        setServerTimeOffset(value) { currentOffset = value },
        settleMissionCategories() { throw new Error("injected settlement failure") },
        SCENARIOS: [{ name: "settlement-failure", create() { return 1 } }],
    }

    try {
        assert.throws(
            () => runMissionSettlementBaseline({
                measurements: 1,
                runtimeLoader: () => runtime,
                temporaryParent,
                warmups: 0,
            }),
            error => {
                assert.match(error.message, /injected settlement failure/)
                assert.match(error.cause.message, /injected shared close failure/)
                return true
            },
        )
        assert.equal(databaseHandle.open, false)
        assert.equal(currentOffset, originalOffset)
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("uses fixed scenario-unique identity provider ids", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "mission_settlement_scenarios.cjs"),
        "utf8",
    )
    assert.doesNotMatch(source, /randomUUID/)
    assert.match(source, /idpId:\s*name/)
})

test("does not leak domain diagnostics to stdout while running the baseline", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-stdout-"))
    const observed = []
    const originalLog = console.log
    try {
        console.log = (...values) => observed.push(values.join(" "))
        runMissionSettlementBaseline({
            measurements: 1,
            temporaryParent,
            warmups: 0,
        })
        assert.deepEqual(observed, [])
    } finally {
        console.log = originalLog
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("stable summary is independent of the global server time", { timeout: 120_000 }, () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-time-"))
    const originalTimeOffset = getTimeOffset()
    const originalLog = console.log

    try {
        console.log = () => {}
        const earlyOffset = Date.parse("2024-07-18T12:00:00.000Z") - Date.now()
        setServerTimeOffset(earlyOffset)
        const earlySummary = runMissionSettlementBaseline({
            measurements: 1,
            temporaryParent,
            warmups: 0,
        }).stableSummary
        assert.equal(getTimeOffset(), earlyOffset)

        const lateOffset = Date.parse("2026-11-12T13:14:15.000Z") - Date.now()
        setServerTimeOffset(lateOffset)
        const lateSummary = runMissionSettlementBaseline({
            measurements: 1,
            temporaryParent,
            warmups: 0,
        }).stableSummary
        assert.equal(getTimeOffset(), lateOffset)

        assert.deepEqual(lateSummary, earlySummary)
    } finally {
        try {
            setServerTimeOffset(originalTimeOffset)
        } finally {
            console.log = originalLog
            fs.rmSync(temporaryParent, { recursive: true, force: true })
        }
    }
})

test("runs all synthetic scenarios against disposable databases", { timeout: 120_000 }, () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-test-"))
    const realDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-real-data-"))
    const markerPath = path.join(realDataDirectory, "marker.txt")
    fs.writeFileSync(markerPath, "unchanged", "utf8")
    const previousDataDirectory = process.env.DATA_DIR
    process.env.DATA_DIR = realDataDirectory

    try {
        const report = runMissionSettlementBaseline({
            measurements: 1,
            temporaryParent,
            warmups: 0,
        })

        assert.equal(report.fixedTime, FIXED_TIME)
        assert.equal(report.warmups, 0)
        assert.equal(report.measurements, 1)
        assert.deepEqual(report.scenarios.map(({ name }) => name), [
            "new-account",
            "normal-progress",
            "high-completion-volume",
        ])
        for (const scenario of report.scenarios) {
            assert.equal(Number.isFinite(scenario.latencyMs.p50), true)
            assert.equal(Number.isFinite(scenario.latencyMs.p95), true)
            assert.equal(
                scenario.sql.statements,
                scenario.sql.selectStatements
                    + scenario.sql.writeStatements
                    + scenario.sql.transactionStatements,
            )
            assert.equal(scenario.sql.selectStatements > 0, true)
            assert.equal(Object.keys(scenario.sql.byTable).length > 0, true)
            assert.equal(scenario.missions.candidates >= scenario.missions.computed, true)
            assert.equal(scenario.missions.progressChanged >= 0, true)
            assert.equal(scenario.rewardStagesGranted >= 0, true)
            for (const category of [1, 2, 3, 6, 7, 8, 10]) {
                assert.equal(Object.hasOwn(scenario.missions.byCategory, String(category)), true)
                assert.equal(
                    scenario.missions.byCategory[String(category)].rewardStagesGranted >= 0,
                    true,
                )
            }
        }
        for (const scenario of report.scenarios.filter(({ name }) => name !== "new-account")) {
            assert.equal(scenario.missions.byCategory["3"].computed > 0, true)
            assert.equal(scenario.missions.byCategory["3"].progressChanged > 0, true)
        }
        for (const category of [1, 2, 3, 6, 7, 8, 10]) {
            assert.equal(
                report.scenarios.some(scenario => (
                    scenario.missions.byCategory[String(category)].computed > 0
                )),
                true,
                `category ${category} must compute missions in at least one scenario`,
            )
        }
        assert.deepEqual(report.stableSummary, JSON.parse(fs.readFileSync(snapshotPath, "utf8")))
        assert.equal(fs.readFileSync(markerPath, "utf8"), "unchanged")
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        fs.rmSync(temporaryParent, { recursive: true, force: true })
        fs.rmSync(realDataDirectory, { recursive: true, force: true })
    }
})

test("writes JSON to stdout and only writes a file when explicitly requested", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-report-output-"))
    const report = { version: 1, stableSummary: { sha256: "a".repeat(64) } }
    let stdout = ""

    try {
        writeReport(report, { output: null, stdout: value => { stdout += value } })
        assert.deepEqual(JSON.parse(stdout), report)
        assert.deepEqual(fs.readdirSync(temporaryDirectory), [])

        stdout = ""
        const output = path.join(temporaryDirectory, "report.json")
        writeReport(report, { output, stdout: value => { stdout += value } })
        assert.deepEqual(JSON.parse(stdout), report)
        assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), report)
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
})
