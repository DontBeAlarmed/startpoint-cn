"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const test = require("node:test")

const {
    createBehaviorSummary,
    evaluateFocusedMissionAdmission,
    formatFocusedMissionAdmissionFailures,
} = require("./mission_engine_focused_admission.cjs")

const STABLE_BEHAVIOR_SHA256 =
    "880ce90eba08796df5b0403750426a0fc476acd2c596ebb6fc7da1eaa7572c84"

function createReport() {
    return {
        version: 1,
        fixedTime: "2025-01-01T12:00:00.000Z",
        scenarios: {
            focused: {
                sqlReads: 10,
                sqlWrites: 5,
                missionComputes: 20,
                behavior: { result: "stable" },
                behaviorSha256: STABLE_BEHAVIOR_SHA256,
            },
        },
    }
}

function failureMetrics(admission) {
    return admission.failures.map(failure => `${failure.scenario}:${failure.metric}`)
}

function hashSerializedBehavior(serialized) {
    return crypto.createHash("sha256").update(serialized).digest("hex")
}

test("focused admission rejects behavior payload and hash changes", () => {
    const snapshot = createReport()
    const current = createReport()
    current.scenarios.focused.behavior.result = "changed"
    current.scenarios.focused.behaviorSha256 = "b".repeat(64)

    const admission = evaluateFocusedMissionAdmission(current, snapshot)

    assert.equal(admission.admitted, false)
    assert.deepEqual(failureMetrics(admission), [
        "focused:behavior",
        "focused:behaviorSha256",
    ])
})

test("focused admission classifies two valid different behaviors as equivalence only", () => {
    const snapshot = createReport()
    const current = createReport()
    Object.assign(current.scenarios.focused, createBehaviorSummary({ result: "changed" }))

    const admission = evaluateFocusedMissionAdmission(current, snapshot)

    assert.equal(admission.admitted, false)
    assert.deepEqual(admission.failures.map(failure => failure.type), ["behavior-equivalence"])
    assert.equal(admission.behaviorEquivalent, false)
    for (const flag of [
        "structuralNonIncreasing",
        "scenarioSetEquivalent",
        "metricsValid",
        "reportStructureValid",
        "scenarioFieldsValid",
    ]) assert.equal(admission[flag], true, flag)
})

test("focused admission allows an explicitly approved behavior change without relaxing metrics", () => {
    const snapshot = createReport()
    const current = createReport()
    Object.assign(current.scenarios.focused, createBehaviorSummary({ result: "changed" }))

    const approved = evaluateFocusedMissionAdmission(current, snapshot, {
        allowBehaviorChange: true,
    })
    assert.equal(approved.admitted, true)
    assert.deepEqual(approved.failures, [])

    current.scenarios.focused.sqlReads++
    const regression = evaluateFocusedMissionAdmission(current, snapshot, {
        allowBehaviorChange: true,
    })
    assert.equal(regression.admitted, false)
    assert.deepEqual(failureMetrics(regression), ["focused:sqlReads"])
})

test("focused admission rejects non-JSON behavior trees without throwing", () => {
    const circular = { value: 1 }
    circular.self = circular
    const cases = [
        ["circular", circular, "0".repeat(64)],
        ["date", new Date("2025-01-01T12:00:00.000Z"), hashSerializedBehavior("{}")],
        ["map", new Map([["value", 1]]), hashSerializedBehavior("{}")],
        ["undefined", { value: undefined }, hashSerializedBehavior("{}")],
        ["NaN", { value: Number.NaN }, hashSerializedBehavior('{"value":null}')],
        ["Infinity", { value: Number.POSITIVE_INFINITY }, hashSerializedBehavior('{"value":null}')],
    ]

    for (const [label, behavior, behaviorSha256] of cases) {
        const current = createReport()
        current.scenarios.focused.behavior = behavior
        current.scenarios.focused.behaviorSha256 = behaviorSha256
        let admission

        assert.doesNotThrow(() => {
            admission = evaluateFocusedMissionAdmission(current, createReport())
        }, label)
        assert.equal(admission.admitted, false, label)
        assert.ok(admission.failures.some(failure => (
            failure.type === "behavior-integrity"
                && failure.scenario === "focused"
                && failure.metric === "behavior"
        )), label)
    }
})

for (const metric of ["sqlReads", "sqlWrites", "missionComputes"]) {
    test(`focused admission rejects an increase in ${metric}`, () => {
        const snapshot = createReport()
        const current = createReport()
        current.scenarios.focused[metric]++

        const admission = evaluateFocusedMissionAdmission(current, snapshot)

        assert.equal(admission.admitted, false)
        assert.deepEqual(failureMetrics(admission), [`focused:${metric}`])
    })
}

test("focused admission accepts structural metric decreases", () => {
    const snapshot = createReport()
    const current = createReport()
    current.scenarios.focused.sqlReads = 2
    current.scenarios.focused.sqlWrites = 1
    current.scenarios.focused.missionComputes = 3

    assert.deepEqual(evaluateFocusedMissionAdmission(current, snapshot), {
        behaviorEquivalent: true,
        structuralNonIncreasing: true,
        scenarioSetEquivalent: true,
        metricsValid: true,
        reportStructureValid: true,
        scenarioFieldsValid: true,
        admitted: true,
        failures: [],
        canonicalReport: current,
    })
})

test("focused admission rejects missing and unexpected scenarios", () => {
    const snapshot = createReport()
    snapshot.scenarios.second = structuredClone(snapshot.scenarios.focused)
    const current = createReport()
    current.scenarios.unexpected = structuredClone(current.scenarios.focused)

    const admission = evaluateFocusedMissionAdmission(current, snapshot)

    assert.equal(admission.admitted, false)
    assert.deepEqual(failureMetrics(admission), [
        "second:scenario",
        "unexpected:scenario",
    ])
})

test("focused admission compares scenario own keys without prototype fallthrough", () => {
    for (const scenarioName of ["toString", "__proto__"]) {
        const snapshot = createReport()
        Object.defineProperty(snapshot.scenarios, scenarioName, {
            configurable: true,
            enumerable: true,
            value: structuredClone(snapshot.scenarios.focused),
            writable: true,
        })
        const current = createReport()

        const admission = evaluateFocusedMissionAdmission(current, snapshot)

        assert.equal(admission.admitted, false, scenarioName)
        assert.ok(
            failureMetrics(admission).includes(`${scenarioName}:scenario`),
            scenarioName,
        )
    }
})

test("focused admission enforces exact top-level metadata and fixed contract", () => {
    const cases = [
        ["version mismatch", report => { report.version = 2 }, "version"],
        ["time mismatch", report => { report.fixedTime = "2025-01-02T12:00:00.000Z" }, "fixedTime"],
        ["missing version", report => { delete report.version }, "fields"],
        ["extra hostname", report => { report.hostname = "builder.local" }, "fields"],
    ]
    for (const [label, mutate, metric] of cases) {
        const current = createReport()
        const snapshot = createReport()
        mutate(current)

        const admission = evaluateFocusedMissionAdmission(current, snapshot)

        assert.equal(admission.admitted, false, label)
        assert.ok(failureMetrics(admission).includes(`current:${metric}`), label)
    }

    const current = createReport()
    const snapshot = createReport()
    current.fixedTime = "2025-01-02T12:00:00.000Z"
    snapshot.fixedTime = current.fixedTime
    assert.equal(evaluateFocusedMissionAdmission(current, snapshot).admitted, false)
})

test("focused admission rejects extra scenario fields", () => {
    for (const side of ["current", "snapshot"]) {
        const current = createReport()
        const snapshot = createReport()
        const report = side === "current" ? current : snapshot
        report.scenarios.focused.hostname = "builder.local"

        const admission = evaluateFocusedMissionAdmission(current, snapshot)

        assert.equal(admission.admitted, false, side)
        assert.ok(failureMetrics(admission).includes("focused:fields"), side)
    }
})

test("focused admission recomputes each canonical behavior hash", () => {
    const forgedCurrent = createReport()
    const forgedSnapshot = createReport()
    forgedCurrent.scenarios.focused.behaviorSha256 = "f".repeat(64)
    forgedSnapshot.scenarios.focused.behaviorSha256 = "f".repeat(64)
    const forgedAdmission = evaluateFocusedMissionAdmission(forgedCurrent, forgedSnapshot)
    assert.equal(forgedAdmission.admitted, false)
    assert.ok(failureMetrics(forgedAdmission).includes("focused:behaviorSha256"))

    const changedPayload = createReport()
    changedPayload.scenarios.focused.behavior = { result: "changed" }
    const payloadAdmission = evaluateFocusedMissionAdmission(changedPayload, createReport())
    assert.equal(payloadAdmission.admitted, false)
    assert.ok(failureMetrics(payloadAdmission).includes("focused:behaviorSha256"))

    const reordered = createReport()
    reordered.scenarios.focused.behavior = { z: 2, a: 1 }
    const equivalent = createReport()
    equivalent.scenarios.focused.behavior = { a: 1, z: 2 }
    const canonicalHash = require("node:crypto").createHash("sha256")
        .update(JSON.stringify({ a: 1, z: 2 }))
        .digest("hex")
    reordered.scenarios.focused.behaviorSha256 = canonicalHash
    equivalent.scenarios.focused.behaviorSha256 = canonicalHash
    assert.equal(evaluateFocusedMissionAdmission(reordered, equivalent).admitted, true)
})

test("focused admission rejects invalid scenario containers in either report", () => {
    for (const side of ["current", "snapshot"]) {
        for (const scenarios of [null, [], {}]) {
            const current = createReport()
            const snapshot = createReport()
            if (side === "current") current.scenarios = scenarios
            else snapshot.scenarios = scenarios

            const admission = evaluateFocusedMissionAdmission(current, snapshot)

            assert.equal(admission.admitted, false, `${side}:${JSON.stringify(scenarios)}`)
            assert.equal(admission.reportStructureValid, false)
            assert.ok(
                failureMetrics(admission).includes(`${side}:scenarios`),
                `${side}:${JSON.stringify(scenarios)}`,
            )
        }
    }
})

test("focused admission rejects missing or invalid behavior and hash fields", () => {
    for (const field of ["behavior", "behaviorSha256"]) {
        for (const side of ["current", "snapshot"]) {
            const current = createReport()
            const snapshot = createReport()
            const report = side === "current" ? current : snapshot
            delete report.scenarios.focused[field]

            const admission = evaluateFocusedMissionAdmission(current, snapshot)

            assert.equal(admission.admitted, false, `${side}:${field}`)
            assert.equal(admission.scenarioFieldsValid, false, `${side}:${field}`)
            assert.ok(
                failureMetrics(admission).includes(`focused:${field}`),
                `${side}:${field}`,
            )
        }
    }

    const invalidBehavior = createReport()
    invalidBehavior.scenarios.focused.behavior = []
    const invalidHash = createReport()
    invalidHash.scenarios.focused.behaviorSha256 = "not-a-sha256"
    const admission = evaluateFocusedMissionAdmission(invalidBehavior, invalidHash)

    assert.equal(admission.admitted, false)
    assert.equal(admission.scenarioFieldsValid, false)
    assert.deepEqual(failureMetrics(admission), [
        "focused:behavior",
        "focused:behaviorSha256",
    ])
})

test("focused admission rejects malformed scenario records without throwing", () => {
    for (const side of ["current", "snapshot"]) {
        const current = createReport()
        const snapshot = createReport()
        const report = side === "current" ? current : snapshot
        report.scenarios.focused = null

        const admission = evaluateFocusedMissionAdmission(current, snapshot)

        assert.equal(admission.admitted, false, side)
        assert.equal(admission.scenarioFieldsValid, false, side)
        for (const metric of ["scenario", "behavior", "behaviorSha256"]) {
            assert.ok(failureMetrics(admission).includes(`focused:${metric}`), `${side}:${metric}`)
        }
    }
})

test("focused admission rejects non-integer current or snapshot metrics", () => {
    const snapshot = createReport()
    const current = createReport()
    snapshot.scenarios.focused.sqlWrites = 5.5
    current.scenarios.focused.sqlReads = "10"

    const admission = evaluateFocusedMissionAdmission(current, snapshot)

    assert.equal(admission.admitted, false)
    assert.deepEqual(failureMetrics(admission), [
        "focused:sqlReads",
        "focused:sqlWrites",
    ])
})

test("invalid report structure makes every derived gate false", () => {
    const admission = evaluateFocusedMissionAdmission({}, {})
    for (const flag of [
        "behaviorEquivalent",
        "structuralNonIncreasing",
        "scenarioSetEquivalent",
        "metricsValid",
        "reportStructureValid",
        "scenarioFieldsValid",
    ]) {
        assert.equal(admission[flag], false, flag)
    }
    assert.equal(admission.admitted, false)
})

test("invalid scenario structure makes every derived gate false", () => {
    const current = createReport()
    current.scenarios.focused.hostname = "builder.local"
    const admission = evaluateFocusedMissionAdmission(current, createReport())
    for (const flag of [
        "behaviorEquivalent",
        "structuralNonIncreasing",
        "scenarioSetEquivalent",
        "metricsValid",
        "reportStructureValid",
        "scenarioFieldsValid",
    ]) {
        assert.equal(admission[flag], false, flag)
    }
    assert.equal(admission.admitted, false)
})

test("focused admission diagnostics serialize exceptional values safely", () => {
    const circular = { value: Number.NaN }
    circular.self = circular
    const admission = {
        failures: [{
            scenario: "focused",
            metric: "diagnostic",
            reason: "test values",
            actual: { bigint: 7n, infinity: Number.POSITIVE_INFINITY },
            expected: circular,
        }],
    }

    let messages
    assert.doesNotThrow(() => {
        messages = formatFocusedMissionAdmissionFailures(admission)
    })
    assert.match(messages[0], /7n/)
    assert.match(messages[0], /Infinity/)
    assert.match(messages[0], /NaN/)
    assert.match(messages[0], /Circular/)
})
