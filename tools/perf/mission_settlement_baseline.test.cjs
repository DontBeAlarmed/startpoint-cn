"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
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

test("classifies SQL totals, reads, writes, and touched tables", () => {
    const counter = createSqlCounter()
    counter.observe("BEGIN")
    counter.observe("SELECT p.id FROM players p JOIN players_items i ON i.player_id = p.id")
    counter.observe("INSERT INTO players_category_missions (player_id, mission_id) VALUES (1, 1)")
    counter.observe("UPDATE players SET free_vmoney = 10 WHERE id = 1")
    counter.observe("COMMIT")

    assert.deepEqual(counter.snapshot(), {
        total: 5,
        select: 1,
        writes: 2,
        other: 2,
        byTable: {
            players: { total: 2, select: 1, writes: 1 },
            players_category_missions: { total: 1, select: 0, writes: 1 },
            players_items: { total: 1, select: 1, writes: 0 },
        },
    })
})

test("stable summaries exclude observed timings and remain deterministic", () => {
    const base = {
        version: 1,
        fixedTime: FIXED_TIME,
        warmups: 2,
        measurements: 2,
        scenarios: [{
            name: "new-account",
            latencyMs: { p50: 1.25, p95: 3.5 },
            sql: { total: 1, select: 1, writes: 0, other: 0, byTable: {} },
            missions: {
                candidates: 10,
                computed: 4,
                progressChanged: 0,
                byCategory: {},
            },
            rewards: 0,
        }],
    }
    const slower = structuredClone(base)
    slower.scenarios[0].latencyMs = { p50: 999, p95: 1200 }

    assert.deepEqual(createStableSummary(base), createStableSummary(slower))
    assert.match(createStableSummary(base).sha256, /^[a-f0-9]{64}$/)
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
            assert.equal(scenario.sql.total >= scenario.sql.select + scenario.sql.writes, true)
            assert.equal(scenario.sql.select > 0, true)
            assert.equal(Object.keys(scenario.sql.byTable).length > 0, true)
            assert.equal(scenario.missions.candidates >= scenario.missions.computed, true)
            assert.equal(scenario.missions.progressChanged >= 0, true)
            assert.equal(scenario.rewards >= 0, true)
            for (const category of [1, 2, 3, 6, 7, 8, 10]) {
                assert.equal(Object.hasOwn(scenario.missions.byCategory, String(category)), true)
            }
        }
        assert.equal(
            report.scenarios.some(scenario => (
                scenario.missions.byCategory["3"].computed === 0
                || scenario.missions.byCategory["6"].computed === 0
                || scenario.missions.byCategory["7"].computed === 0
                || scenario.missions.byCategory["8"].computed === 0
            )),
            true,
        )
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
