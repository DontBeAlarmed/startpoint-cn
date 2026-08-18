"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { createActiveMissionObserver } = require("./active-mission/observer.cjs")
const {
    evaluateActiveMissionReport,
} = require("./active-mission/admission.cjs")
const {
    describeActiveMissionFixture,
    normalizeActiveMissionScenario,
    selectActiveMissionFixture,
} = require("./active-mission/fixture.cjs")
const {
    canonicalizeActiveMissionReport,
} = require("./active-mission/report.cjs")
const { SCENARIOS } = require("./mission_settlement_scenarios.cjs")

function validReport(overrides = {}) {
    return {
        version: 1,
        fixture: { name: "new-account", profile: "New", scale: 0 },
        behaviorHash: "a".repeat(64),
        unsupportedMissionIds: [21030],
        factLoaders: {
            characters: { calls: 1, rows: 13 },
        },
        structural: {
            sqlReads: 10,
            sqlWrites: 2,
            definitionVisits: 1,
            loaderCalls: 1,
            staticComputes: 1,
            dependencyComputes: 1,
        },
        ...overrides,
    }
}

test("observer separates static and dependency computes", () => {
    const observer = createActiveMissionObserver()

    observer.definitionVisited(11010)
    observer.factLoaded("characters", 13)
    observer.staticComputed(11010)
    observer.dependencyComputed(11090)

    assert.deepEqual(observer.snapshot(), {
        definitionVisits: 1,
        factLoaders: { characters: { calls: 1, rows: 13 } },
        staticComputes: 1,
        dependencyComputes: 1,
    })
})

test("observer snapshot is stable and immutable", () => {
    const observer = createActiveMissionObserver()
    observer.factLoaded("equipment", 2)
    observer.factLoaded("characters", 1)

    const snapshot = observer.snapshot()
    assert.deepEqual(Object.keys(snapshot.factLoaders), ["characters", "equipment"])
    assert.throws(() => { snapshot.factLoaders.characters.calls = 99 }, TypeError)
    assert.deepEqual(observer.snapshot().factLoaders.characters, { calls: 1, rows: 1 })
})

test("admission rejects changed fail-closed ids", () => {
    const baseline = validReport()
    const current = validReport({ unsupportedMissionIds: [21030, 25009] })

    const admission = evaluateActiveMissionReport(baseline, current)

    assert.equal(admission.behaviorEquivalent, false)
    assert.equal(admission.admitted, false)
    assert.equal(admission.unsupportedMissionSetEquivalent, false)
})

test("admission rejects reports with different fixture scales", () => {
    const baseline = validReport()
    const current = validReport({ fixture: describeActiveMissionFixture("Small") })

    const admission = evaluateActiveMissionReport(baseline, current)

    assert.equal(admission.behaviorEquivalent, false)
    assert.equal(admission.admitted, false)
    assert.deepEqual(admission.failures, ["fixture/workload mismatch"])
})

test("admission fails closed when fixture fields are missing", () => {
    const fixture = { name: "new-account", profile: "New" }
    let admission

    assert.doesNotThrow(() => {
        admission = evaluateActiveMissionReport(validReport(), validReport({ fixture }))
    })
    assert.equal(admission.admitted, false)
    assert.equal(admission.reportStructureValid, false)
})

test("admission fails closed when fixture fields are unexpected", () => {
    const fixture = {
        name: "new-account",
        profile: "New",
        scale: 0,
        shard: "local",
    }
    let admission

    assert.doesNotThrow(() => {
        admission = evaluateActiveMissionReport(validReport(), validReport({ fixture }))
    })
    assert.equal(admission.admitted, false)
    assert.equal(admission.reportStructureValid, false)
})

test("admission rejects sparse arrays, NaN, negative values, and contradictory metrics fail closed", () => {
    const malformedReports = [
        { ...validReport(), unsupportedMissionIds: Object.assign([], { 1: 21030, length: 2 }) },
        { ...validReport(), structural: { ...validReport().structural, sqlReads: Number.NaN } },
        { ...validReport(), unsupportedMissionIds: [-1] },
        {
            ...validReport(),
            structural: { ...validReport().structural, loaderCalls: 2 },
        },
    ]

    for (const malformed of malformedReports) {
        let admission
        assert.doesNotThrow(() => {
            admission = evaluateActiveMissionReport(validReport(), malformed)
        })
        for (const gate of [
            "behaviorEquivalent",
            "unsupportedMissionSetEquivalent",
            "structuralNonIncreasing",
            "reportStructureValid",
            "metricsValid",
        ]) assert.equal(admission[gate], false, gate)
        assert.equal(admission.admitted, false)
    }
})

test("admission rejects repeated current fact loader calls even when totals do not increase", () => {
    const baseline = validReport({
        factLoaders: {
            A: { calls: 1, rows: 1 },
            B: { calls: 1, rows: 1 },
        },
        structural: { ...validReport().structural, loaderCalls: 2 },
    })
    const current = validReport({
        factLoaders: {
            A: { calls: 2, rows: 2 },
        },
        structural: { ...validReport().structural, loaderCalls: 2 },
    })

    const admission = evaluateActiveMissionReport(baseline, current)

    assert.equal(admission.structuralNonIncreasing, false)
    assert.equal(admission.admitted, false)
    assert.match(admission.failures.join("\n"), /fact loader A.*multiple calls/i)
})

test("canonical reports allow repeated baseline loads when current uses one call", () => {
    const baseline = canonicalizeActiveMissionReport(validReport({
        factLoaders: { A: { calls: 2, rows: 2 } },
        structural: { ...validReport().structural, loaderCalls: 2 },
    }))
    const current = canonicalizeActiveMissionReport(validReport({
        factLoaders: { A: { calls: 1, rows: 1 } },
    }))

    assert.equal(baseline.factLoaders.A.calls, 2)
    assert.equal(evaluateActiveMissionReport(baseline, current).admitted, true)
})

test("fixture scale contract reuses mission settlement scenario semantics", () => {
    assert.deepEqual(normalizeActiveMissionScenario("New"), "new-account")
    assert.deepEqual(normalizeActiveMissionScenario("Small"), "normal-progress")
    assert.deepEqual(normalizeActiveMissionScenario("Large"), "high-completion-volume")
    assert.deepEqual(describeActiveMissionFixture("New"), {
        name: "new-account",
        profile: "New",
        scale: 0,
    })
    assert.deepEqual(describeActiveMissionFixture("Small"), {
        name: "normal-progress",
        profile: "Small",
        scale: 3,
    })
    assert.deepEqual(describeActiveMissionFixture("Large"), {
        name: "high-completion-volume",
        profile: "Large",
        scale: 20,
    })
    for (const [profile, name, scale] of [
        ["New", "new-account", 0],
        ["Small", "normal-progress", 3],
        ["Large", "high-completion-volume", 20],
    ]) {
        const scenario = selectActiveMissionFixture(profile)
        assert.equal(scenario.name, name)
        assert.equal(scenario.scale, scale)
        assert.equal(SCENARIOS.find(candidate => candidate.name === name).scale, scale)
    }
    assert.throws(() => normalizeActiveMissionScenario("medium"), /unknown active mission scenario/i)
})

test("report rejects special fact loader keys without throwing", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
        const factLoaders = {}
        Object.defineProperty(factLoaders, name, {
            configurable: true,
            enumerable: true,
            value: { calls: 1, rows: 13 },
        })
        const malformed = validReport({ factLoaders })
        let admission
        assert.doesNotThrow(() => {
            admission = evaluateActiveMissionReport(validReport(), malformed)
        }, name)
        for (const gate of [
            "behaviorEquivalent",
            "unsupportedMissionSetEquivalent",
            "structuralNonIncreasing",
            "reportStructureValid",
            "metricsValid",
        ]) assert.equal(admission[gate], false, `${name}:${gate}`)
        assert.equal(admission.admitted, false, name)
    }
})

test("canonical report sorts IDs and recursively freezes nested metrics", () => {
    const report = canonicalizeActiveMissionReport(validReport({
        unsupportedMissionIds: [25009, 21030],
    }))

    assert.deepEqual(report.unsupportedMissionIds, [21030, 25009])
    assert.throws(() => { report.factLoaders.characters.calls = 9 }, TypeError)
    assert.throws(() => { report.structural.sqlReads = 99 }, TypeError)
})

test("fixture validation compares fields independently of property order", () => {
    const baseline = validReport()
    const current = validReport({
        fixture: { scale: 0, profile: "New", name: "new-account" },
    })

    assert.equal(evaluateActiveMissionReport(baseline, current).admitted, true)
})
