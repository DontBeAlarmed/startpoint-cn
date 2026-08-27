"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    createSingleBattleReport,
    evaluateSingleBattleAdmission,
    writeAdmittedSnapshot,
} = require("./single_battle_settlement_admission.cjs")
const {
    admitSingleBattleReport,
} = require("./single_battle_settlement_baseline.cjs")
const singleBattleSnapshot = require("./__snapshots__/single_battle_settlement_baseline.json")

function scenario(behavior = { result: "stable" }) {
    return {
        behavior,
        behaviorSha256: "",
        sql: {
            statements: 4,
            selectStatements: 2,
            writeStatements: 1,
            transactionStatements: 1,
            byTable: {
                players: { statements: 3, reads: 2, writes: 1 },
            },
        },
    }
}

function report(behavior) {
    return createSingleBattleReport({ focused: scenario(behavior) })
}

test("single battle admission freezes behavior payload, hash, SQL, and scenario set", () => {
    const snapshot = report({ result: "stable" })
    assert.equal(evaluateSingleBattleAdmission(snapshot, snapshot).admitted, true)

    const changedBehavior = structuredClone(snapshot)
    changedBehavior.scenarios.focused.behavior.result = "changed"
    assert.equal(evaluateSingleBattleAdmission(changedBehavior, snapshot).admitted, false)

    const changedSql = structuredClone(snapshot)
    changedSql.scenarios.focused.sql.byTable.players.reads++
    assert.equal(evaluateSingleBattleAdmission(changedSql, snapshot).admitted, false)

    const changedSet = structuredClone(snapshot)
    changedSet.scenarios.extra = structuredClone(changedSet.scenarios.focused)
    assert.equal(evaluateSingleBattleAdmission(changedSet, snapshot).admitted, false)
})

test("single battle report hashes canonical behavior and rejects machine fields", () => {
    const left = report({ z: 2, a: { y: 1, x: 0 } })
    const right = report({ a: { x: 0, y: 1 }, z: 2 })

    assert.deepEqual(left, right)
    assert.match(left.scenarios.focused.behaviorSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(left), ["version", "fixedTime", "scenarios"])

    const invalid = structuredClone(left)
    invalid.hostname = "builder.local"
    assert.equal(evaluateSingleBattleAdmission(invalid, right).admitted, false)
})

test("snapshot writer requires admission and replaces the target atomically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "single-battle-admission-"))
    const snapshotPath = path.join(directory, "baseline.json")
    const renameCalls = []
    try {
        const snapshot = report({ result: "stable" })
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        const changed = report({ result: "changed" })
        assert.throws(
            () => writeAdmittedSnapshot(changed, snapshotPath),
            /admission failed/i,
        )
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), snapshot)

        writeAdmittedSnapshot(snapshot, snapshotPath, {
            renameSync(from, to) {
                renameCalls.push([path.dirname(from), to])
                fs.renameSync(from, to)
            },
        })
        assert.deepEqual(renameCalls, [[directory, snapshotPath]])
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), snapshot)
        assert.deepEqual(
            fs.readdirSync(directory).filter(name => name !== "baseline.json"),
            [],
        )
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("snapshot writer requires explicit approval for an intentional behavior change", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "single-battle-behavior-admission-"))
    const snapshotPath = path.join(directory, "baseline.json")
    try {
        const snapshot = report({ result: "stable" })
        const changed = report({ result: "intentional-change" })
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)

        assert.throws(() => writeAdmittedSnapshot(changed, snapshotPath), /behavior differs/i)
        writeAdmittedSnapshot(changed, snapshotPath, { allowBehaviorChange: true })
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), changed)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("snapshot writer admits behavior-equivalent SQL reductions but rejects regressions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "single-battle-sql-admission-"))
    const snapshotPath = path.join(directory, "baseline.json")
    try {
        const snapshot = report({ result: "stable" })
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)

        const optimized = structuredClone(snapshot)
        optimized.scenarios.focused.sql.statements--
        optimized.scenarios.focused.sql.selectStatements--
        optimized.scenarios.focused.sql.byTable.players.statements--
        optimized.scenarios.focused.sql.byTable.players.reads--
        writeAdmittedSnapshot(optimized, snapshotPath)
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), optimized)

        const regression = structuredClone(optimized)
        regression.scenarios.focused.sql.statements++
        regression.scenarios.focused.sql.selectStatements++
        regression.scenarios.focused.sql.byTable.players.statements++
        regression.scenarios.focused.sql.byTable.players.reads++
        assert.throws(
            () => writeAdmittedSnapshot(regression, snapshotPath),
            /structural SQL regression/i,
        )
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("SQL reduction admission enforces every existing table and rejects new tables", () => {
    const snapshot = report({ result: "stable" })

    const tableRegression = structuredClone(snapshot)
    tableRegression.scenarios.focused.sql.byTable.players.statements++
    tableRegression.scenarios.focused.sql.byTable.players.reads++
    assert.equal(evaluateSingleBattleAdmission(
        tableRegression,
        snapshot,
        { allowSqlReduction: true },
    ).admitted, false)

    const newTable = structuredClone(snapshot)
    newTable.scenarios.focused.sql.byTable.new_rewards = {
        statements: 1,
        reads: 1,
        writes: 0,
    }
    assert.equal(evaluateSingleBattleAdmission(
        newTable,
        snapshot,
        { allowSqlReduction: true },
    ).admitted, false)

    const tableReduction = structuredClone(snapshot)
    tableReduction.scenarios.focused.sql.byTable.players.statements--
    tableReduction.scenarios.focused.sql.byTable.players.reads--
    assert.equal(evaluateSingleBattleAdmission(
        tableReduction,
        snapshot,
        { allowSqlReduction: true },
    ).admitted, true)

    const removedTable = structuredClone(snapshot)
    removedTable.scenarios.focused.sql.statements--
    removedTable.scenarios.focused.sql.writeStatements--
    delete removedTable.scenarios.focused.sql.byTable.players
    assert.equal(evaluateSingleBattleAdmission(
        removedTable,
        snapshot,
        { allowSqlReduction: true },
    ).admitted, true)

    for (const invalidMetric of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const invalidTable = structuredClone(snapshot)
        invalidTable.scenarios.focused.sql.byTable.players.reads = invalidMetric
        assert.equal(evaluateSingleBattleAdmission(
            invalidTable,
            snapshot,
            { allowSqlReduction: true },
        ).admitted, false)
    }
})

test("SQL reduction rejects start_normal table metrics with accesses but no statements", () => {
    const malformed = structuredClone(singleBattleSnapshot)
    malformed.scenarios.start_normal.sql.byTable.players = {
        statements: 0,
        reads: 4,
        writes: 1,
    }

    assert.equal(evaluateSingleBattleAdmission(
        malformed,
        singleBattleSnapshot,
        { allowSqlReduction: true },
    ).admitted, false)
})

test("SQL reduction rejects table statement counts above reads plus writes", () => {
    const malformed = structuredClone(singleBattleSnapshot)
    malformed.scenarios.start_normal.sql.byTable.players = {
        statements: 5,
        reads: 3,
        writes: 1,
    }

    assert.equal(evaluateSingleBattleAdmission(
        malformed,
        singleBattleSnapshot,
        { allowSqlReduction: true },
    ).admitted, false)
})

test("SQL canonicalization rejects table metrics above the non-transaction summary", () => {
    const malformed = report({ result: "stable" })
    malformed.scenarios.focused.sql.byTable.players = {
        statements: 4,
        reads: 3,
        writes: 1,
    }

    assert.equal(evaluateSingleBattleAdmission(
        malformed,
        malformed,
        { allowSqlReduction: true },
    ).admitted, false)
})

test("SQL reduction rejects byTable write totals that differ from writeStatements", () => {
    const malformed = structuredClone(singleBattleSnapshot)
    malformed.scenarios.start_normal.sql.byTable.players = {
        statements: 4,
        reads: 4,
        writes: 0,
    }

    assert.equal(evaluateSingleBattleAdmission(
        malformed,
        singleBattleSnapshot,
        { allowSqlReduction: true },
    ).admitted, false)
})

test("snapshot writer admits only the known stamina time semantics migration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "single-battle-time-admission-"))
    const snapshotPath = path.join(directory, "baseline.json")
    try {
        const snapshot = report({
            database: { staminaHealTime: "fixture-stamina-time" },
            response: { stamina_heal_time: "rank-up-settlement-time" },
            result: "stable",
        })
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        const migrated = report({
            database: { staminaHealTime: "fixed-fixture-time" },
            response: { stamina_heal_time: "matches-database-virtual-time" },
            result: "stable",
        })
        writeAdmittedSnapshot(migrated, snapshotPath)
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), migrated)

        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        const changedBehavior = report({
            database: { staminaHealTime: "fixed-fixture-time" },
            response: { stamina_heal_time: "matches-database-virtual-time" },
            result: "changed",
        })
        assert.throws(
            () => writeAdmittedSnapshot(changedBehavior, snapshotPath),
            /behavior differs/i,
        )
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("baseline write entry uses optimization admission instead of strict read admission", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "single-battle-write-entry-"))
    const snapshotPath = path.join(directory, "baseline.json")
    try {
        const snapshot = report({ result: "stable" })
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        const optimized = structuredClone(snapshot)
        optimized.scenarios.focused.sql.statements--
        optimized.scenarios.focused.sql.selectStatements--
        optimized.scenarios.focused.sql.byTable.players.statements--
        optimized.scenarios.focused.sql.byTable.players.reads--

        assert.equal(evaluateSingleBattleAdmission(optimized, snapshot).admitted, false)
        assert.equal(admitSingleBattleReport(optimized, { snapshotPath, write: true }).admitted, true)
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), optimized)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
