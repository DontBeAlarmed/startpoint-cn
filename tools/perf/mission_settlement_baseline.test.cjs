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
        total: 3,
        select: 1,
        writes: 2,
        transactions: 0,
        other: 0,
        byTable: {
            players: { total: 2, select: 1, writes: 1 },
            players_category_missions: { total: 1, select: 0, writes: 1 },
            players_items: { total: 1, select: 1, writes: 0 },
        },
    })
})

test("classifies SQLite transaction control separately", () => {
    const counter = createSqlCounter()
    for (const sql of [
        "BEGIN IMMEDIATE",
        "SAVEPOINT mission_settlement",
        "ROLLBACK TO mission_settlement",
        "RELEASE mission_settlement",
        "COMMIT",
        "END",
    ]) counter.observe(sql)

    assert.deepEqual(counter.snapshot(), {
        total: 6,
        select: 0,
        writes: 0,
        transactions: 6,
        other: 0,
        byTable: {},
    })
})

test("classifies supported CTE SELECT and nested entity reads without CTE aliases", () => {
    const counter = createSqlCounter()
    counter.observe(`
        WITH RECURSIVE recent(player_id) AS (
            SELECT player_id FROM players_items WHERE amount > 0
        )
        SELECT p.id FROM players p
        WHERE EXISTS (
            SELECT 1 FROM players_mails m WHERE m.player_id = p.id
        )
        AND p.id IN (SELECT player_id FROM recent)
    `)

    assert.deepEqual(counter.snapshot(), {
        total: 1,
        select: 1,
        writes: 0,
        transactions: 0,
        other: 0,
        byTable: {
            players: { total: 1, select: 1, writes: 0 },
            players_items: { total: 1, select: 1, writes: 0 },
            players_mails: { total: 1, select: 1, writes: 0 },
        },
    })
})

test("classifies supported CTE UPDATE target and source tables", () => {
    const counter = createSqlCounter()
    counter.observe(`
        WITH totals AS (
            SELECT player_id FROM players_items GROUP BY player_id
        )
        UPDATE players
        SET free_mana = (SELECT COUNT(*) FROM totals)
        WHERE id IN (SELECT player_id FROM totals)
    `)

    assert.deepEqual(counter.snapshot(), {
        total: 1,
        select: 0,
        writes: 1,
        transactions: 0,
        other: 0,
        byTable: {
            players: { total: 1, select: 0, writes: 1 },
            players_items: { total: 1, select: 1, writes: 0 },
        },
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
                total: 1,
                select: 1,
                writes: 0,
                transactions: 0,
                other: 0,
                byTable: { players: { total: 1, select: 1, writes: 0 } },
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
        assert.deepEqual(data.getDatabaseStatus(), { open: true, ready: true, schema: 16 })
        assert.deepEqual(fs.readdirSync(temporaryParent), [])
    } finally {
        data.closeDatabase()
        fs.rmSync(databaseRoot, { recursive: true, force: true })
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("cleans its suite directory when dependency loading fails", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-baseline-load-fail-"))
    try {
        assert.throws(
            () => runMissionSettlementBaseline({
                measurements: 1,
                runtimeLoader() { throw new Error("injected dependency failure") },
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
                scenario.sql.total,
                scenario.sql.select
                    + scenario.sql.writes
                    + scenario.sql.transactions
                    + scenario.sql.other,
            )
            assert.equal(scenario.sql.select > 0, true)
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
