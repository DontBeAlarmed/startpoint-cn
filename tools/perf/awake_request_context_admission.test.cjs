"use strict"

const assert = require("node:assert/strict")
const { types } = require("node:util")
const test = require("node:test")

const {
    AWAKE_REQUEST_CONTEXT_FIXED_TIME,
    AWAKE_REQUEST_CONTEXT_REPORT_VERSION,
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
    createAwakeRequestContextReport,
} = require("./awake_request_context_report.cjs")
const {
    evaluateAwakeRequestContextAdmission,
} = require("./awake_request_context_admission.cjs")

function createScenario(overrides = {}) {
    return {
        sqlReads: 4,
        sqlWrites: 1,
        missionComputes: 3,
        sqlByTable: {
            players: { reads: 1, writes: 0, statements: 1 },
            players_character_awake_unlocks: { reads: 2, writes: 1, statements: 2 },
        },
        behavior: { result: true, count: 1 },
        ...overrides,
    }
}

function createReport() {
    return createAwakeRequestContextReport(Object.fromEntries(
        AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
    ))
}

function failureMetrics(admission) {
    return admission.failures.map(failure => `${failure.scenario}:${failure.metric}`)
}

test("report canonicalizes the exact Awake request-context contract", () => {
    const scenarios = Object.fromEntries([...AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS]
        .reverse()
        .map(name => [name, createScenario({
            sqlByTable: {
                players_character_awake_unlocks: {
                    statements: 2,
                    writes: 1,
                    reads: 1,
                },
                players: { statements: 1, writes: 0, reads: 1 },
            },
            behavior: { z: [2, { b: true, a: 1 }], a: "stable" },
        })]))

    const report = createAwakeRequestContextReport(scenarios)

    assert.equal(report.version, AWAKE_REQUEST_CONTEXT_REPORT_VERSION)
    assert.equal(report.fixedTime, AWAKE_REQUEST_CONTEXT_FIXED_TIME)
    assert.deepEqual(Object.keys(report.scenarios), AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS)
    for (const scenario of Object.values(report.scenarios)) {
        assert.deepEqual(Object.keys(scenario), [
            "sqlReads",
            "sqlWrites",
            "missionComputes",
            "sqlByTable",
            "behavior",
            "behaviorSha256",
        ])
        assert.deepEqual(Object.keys(scenario.sqlByTable), [
            "players",
            "players_character_awake_unlocks",
        ])
        assert.deepEqual(scenario.behavior, { a: "stable", z: [2, { a: 1, b: true }] })
        assert.match(scenario.behaviorSha256, /^[a-f0-9]{64}$/)
    }
})

test("admission requires exact behavior and non-increasing structural metrics", () => {
    const snapshot = createReport()
    const current = createReport()
    current.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].sqlReads--
    current.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]]
        .sqlByTable.players.reads--
    current.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]]
        .sqlByTable.players.statements--

    const admission = evaluateAwakeRequestContextAdmission(current, snapshot)

    assert.equal(admission.admitted, true)
    assert.deepEqual(admission.failures, [])
    assert.deepEqual(admission.canonicalReport, current)

    for (const metric of ["sqlReads", "sqlWrites", "missionComputes"]) {
        const regressed = createReport()
        regressed.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]][metric]++
        if (metric === "sqlWrites") {
            const table = regressed.scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]]
                .sqlByTable.players_character_awake_unlocks
            table.writes++
            table.statements++
        }
        const rejected = evaluateAwakeRequestContextAdmission(regressed, snapshot)
        assert.equal(rejected.admitted, false, metric)
        assert.ok(failureMetrics(rejected).includes(
            `${AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]}:${metric}`,
        ))
    }
})

test("admission fails closed on table drift and table metric regressions", () => {
    const scenarioName = AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]
    const snapshot = createReport()
    const tableRegression = createReport()
    tableRegression.scenarios[scenarioName]
        .sqlByTable.players_character_awake_unlocks.statements++
    tableRegression.scenarios[scenarioName].sqlReads++
    const regressed = evaluateAwakeRequestContextAdmission(tableRegression, snapshot)
    assert.equal(regressed.admitted, false)
    assert.ok(failureMetrics(regressed).includes(
        `${scenarioName}:sqlByTable.players_character_awake_unlocks.statements`,
    ))

    const newBusinessTable = createReport()
    newBusinessTable.scenarios[scenarioName].sqlByTable.players_new_business = {
        reads: 1,
        writes: 0,
        statements: 1,
    }
    newBusinessTable.scenarios[scenarioName].sqlReads++
    const added = evaluateAwakeRequestContextAdmission(newBusinessTable, snapshot)
    assert.equal(added.admitted, false)
    assert.ok(failureMetrics(added).includes(`${scenarioName}:sqlByTable.players_new_business`))

    const removedTable = createReport()
    delete removedTable.scenarios[scenarioName].sqlByTable.players
    assert.equal(evaluateAwakeRequestContextAdmission(removedTable, snapshot).admitted, true)

    const sqliteSnapshot = createReport()
    sqliteSnapshot.scenarios[scenarioName].sqlByTable.sqlite_stat = {
        reads: 1,
        writes: 0,
        statements: 1,
    }
    const sqliteRegression = structuredClone(sqliteSnapshot)
    sqliteRegression.scenarios[scenarioName].sqlByTable.sqlite_stat.reads++
    sqliteRegression.scenarios[scenarioName].sqlByTable.sqlite_stat.statements++
    const unlockTable = sqliteRegression.scenarios[scenarioName]
        .sqlByTable.players_character_awake_unlocks
    unlockTable.reads--
    const sqliteAdmission = evaluateAwakeRequestContextAdmission(
        sqliteRegression,
        sqliteSnapshot,
    )
    assert.equal(sqliteAdmission.admitted, false)
    assert.ok(failureMetrics(sqliteAdmission).includes(
        `${scenarioName}:sqlByTable.sqlite_stat.reads`,
    ))
})

test("admission rejects behavior drift and forged behavior hashes", () => {
    const scenarioName = AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]
    const snapshot = createReport()
    const changed = createReport()
    changed.scenarios[scenarioName].behavior.result = false
    const drift = evaluateAwakeRequestContextAdmission(changed, snapshot)
    assert.equal(drift.admitted, false)
    assert.deepEqual(failureMetrics(drift), [
        `${scenarioName}:behaviorSha256`,
        `${scenarioName}:behavior`,
    ])

    const forged = createReport()
    forged.scenarios[scenarioName].behaviorSha256 = "f".repeat(64)
    const integrity = evaluateAwakeRequestContextAdmission(forged, snapshot)
    assert.equal(integrity.admitted, false)
    assert.deepEqual(failureMetrics(integrity), [`${scenarioName}:behaviorSha256`])
})

test("report and admission reject malformed values without invoking accessors", () => {
    const invalidMetrics = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53]
    for (const value of invalidMetrics) {
        const scenarios = Object.fromEntries(
            AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
        )
        scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].sqlReads = value
        assert.throws(() => createAwakeRequestContextReport(scenarios), /invalid|safe integer/i)
    }

    const report = createReport()
    const scenarioName = AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]
    for (const mutate of [
        value => { delete value.scenarios[scenarioName].sqlReads },
        value => { value.scenarios[scenarioName].hostname = "builder.local" },
        value => { value.scenarios.unexpected = structuredClone(value.scenarios[scenarioName]) },
        value => { value.version++ },
        value => { Object.setPrototypeOf(value.scenarios[scenarioName], { inherited: true }) },
    ]) {
        const malformed = structuredClone(report)
        mutate(malformed)
        assert.equal(evaluateAwakeRequestContextAdmission(malformed, report).admitted, false)
    }

    let getterCalls = 0
    const getterReport = structuredClone(report)
    Object.defineProperty(getterReport.scenarios[scenarioName], "sqlReads", {
        enumerable: true,
        get() {
            getterCalls++
            return 4
        },
    })
    assert.equal(evaluateAwakeRequestContextAdmission(getterReport, report).admitted, false)
    assert.equal(getterCalls, 0)

    const proxyReport = new Proxy(structuredClone(report), {})
    assert.equal(types.isProxy(proxyReport), true)
    assert.equal(evaluateAwakeRequestContextAdmission(proxyReport, report).admitted, false)

    const leakedMarker = Reflect.ownKeys(report).find(key => typeof key === "symbol")
    const markerReport = structuredClone(report)
    markerReport.scenarios[scenarioName][leakedMarker] = true
    assert.equal(evaluateAwakeRequestContextAdmission(markerReport, report).admitted, false)

    let markerGetterCalls = 0
    const markerGetterReport = structuredClone(report)
    Object.defineProperty(markerGetterReport, leakedMarker, {
        get() {
            markerGetterCalls++
            return true
        },
    })
    assert.equal(evaluateAwakeRequestContextAdmission(markerGetterReport, report).admitted, false)
    assert.equal(markerGetterCalls, 0)
})

test("report rejects invalid behavior numbers and inconsistent SQL table metrics", () => {
    for (const behavior of [null, [], "stable"]) {
        const scenarios = Object.fromEntries(
            AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
        )
        scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].behavior = behavior
        assert.throws(() => createAwakeRequestContextReport(scenarios), /behavior.*object/i)
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53]) {
        const scenarios = Object.fromEntries(
            AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
        )
        scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]].behavior.count = value
        assert.throws(() => createAwakeRequestContextReport(scenarios), /safe integer/i)
    }

    const scenarios = Object.fromEntries(
        AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [name, createScenario()]),
    )
    scenarios[AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS[0]]
        .sqlByTable.players_character_awake_unlocks.writes = 2
    assert.throws(() => createAwakeRequestContextReport(scenarios), /SQL|write/i)
})
