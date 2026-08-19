"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    ENTRY_NAMES,
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_CONCURRENCY_STEPS,
    FORMAL_ENTRY_REQUESTS,
    FORMAL_INDEPENDENT_SAVES,
    WRITE_ENTRY_NAMES,
    createAdmissionGate,
    validateReportStructure,
} = require("./non_multi_mixed_metrics.cjs")

const EXPECTED_FORMAL_ENTRY_REQUESTS = [86, 86, 86, 86, 86, 85, 85]

function entry(name, requests, overrides = {}) {
    return {
        name,
        requests,
        errors: 0,
        latencyMs: { p50: 1.25, p95: 2.5 },
        behaviorSignatures: [`${name}-stable`],
        sql: { readsMax: 3, writesMax: 2 },
        rollbackVerified: true,
        ...overrides,
    }
}

function report({
    independentSaves = FORMAL_INDEPENDENT_SAVES,
    activeIdentities = FORMAL_ACTIVE_IDENTITIES,
    concurrencies = [...FORMAL_CONCURRENCY_STEPS],
    entryRequests = EXPECTED_FORMAL_ENTRY_REQUESTS,
} = {}) {
    const metadata = {
        fixedTime: "2024-08-14T12:00:00.000Z",
        activeIdentitiesAreConcurrentRequests: false,
        entryDistribution: ENTRY_NAMES.map((name, index) => ({
            name,
            requests: entryRequests[index],
            weight: entryRequests[index] / activeIdentities,
        })),
        entryDistributionNote: "acceptance coverage; not production traffic proportions",
    }
    const result = {
        profile: {
            independentSaves,
            activeIdentities,
            concurrencySteps: [...concurrencies],
        },
        metadata,
        steps: concurrencies.map(concurrency => ({
            concurrency,
            requests: entryRequests.reduce((sum, requests) => sum + requests, 0),
            errors: 0,
            latencyMs: { p50: 2.5, p95: 5.75 },
            throughputPerSecond: 100,
            eventLoopDelayMs: { p50: 0.1, p95: 0.2, max: 0.3 },
            entries: ENTRY_NAMES.map((name, index) => entry(name, entryRequests[index])),
        })),
    }
    if (activeIdentities === FORMAL_ACTIVE_IDENTITIES) {
        for (const step of result.steps) {
            for (const name of ["load", "single-battle"]) {
                step.entries.find(item => item.name === name).behaviorSignatures = [
                    `${name}-large`,
                    `${name}-new`,
                    `${name}-small`,
                ]
            }
        }
    }
    return result
}

function assertClosed(reportValue, label) {
    let structureValid
    let gate
    assert.doesNotThrow(() => {
        structureValid = validateReportStructure(reportValue)
        gate = createAdmissionGate(reportValue)
    }, label)
    assert.equal(structureValid, false, label)
    assert.deepEqual(gate, {
        reportStructureValid: false,
        zeroErrors: false,
        behaviorStable: false,
        rollbackVerified: false,
        loadProfileValid: false,
        admitted: false,
    }, label)
}

test("formal mixed-load constants lock the non-multi model", () => {
    assert.equal(FORMAL_INDEPENDENT_SAVES, 1000)
    assert.equal(FORMAL_ACTIVE_IDENTITIES, 600)
    assert.deepEqual(FORMAL_CONCURRENCY_STEPS, [10, 25, 50, 100])
    assert.deepEqual(FORMAL_ENTRY_REQUESTS, EXPECTED_FORMAL_ENTRY_REQUESTS)
    assert.deepEqual(ENTRY_NAMES, [
        "auth",
        "load",
        "mission-progress",
        "single-battle",
        "shop",
        "gacha",
        "mail",
    ])
    assert.deepEqual(WRITE_ENTRY_NAMES, ["single-battle", "shop", "gacha", "mail"])
    assert.equal(Object.isFrozen(FORMAL_CONCURRENCY_STEPS), true)
    assert.equal(Object.isFrozen(FORMAL_ENTRY_REQUESTS), true)
    assert.equal(Object.isFrozen(ENTRY_NAMES), true)
    assert.equal(Object.isFrozen(WRITE_ENTRY_NAMES), true)
})

test("a valid formal report passes every admission check", () => {
    const formalReport = report()

    assert.equal(validateReportStructure(formalReport), true)
    assert.deepEqual(createAdmissionGate(formalReport), {
        reportStructureValid: true,
        zeroErrors: true,
        behaviorStable: true,
        rollbackVerified: true,
        loadProfileValid: true,
        admitted: true,
    })
})

test("embedded admission gate must match the report evidence", () => {
    const forged = report()
    forged.steps[0].entries.find(item => item.name === "shop").rollbackVerified = false
    forged.gate = {
        reportStructureValid: true,
        zeroErrors: true,
        behaviorStable: true,
        rollbackVerified: true,
        loadProfileValid: true,
        admitted: true,
    }

    assert.equal(validateReportStructure(forged), false)
    assert.equal(createAdmissionGate(forged).admitted, false)
})

test("a smoke report is structurally valid but not formal", () => {
    const smoke = report({
        independentSaves: 12,
        activeIdentities: 7,
        concurrencies: [2],
        entryRequests: Array(ENTRY_NAMES.length).fill(1),
    })

    assert.equal(validateReportStructure(smoke), true)
    assert.deepEqual(createAdmissionGate(smoke), {
        reportStructureValid: true,
        zeroErrors: true,
        behaviorStable: true,
        rollbackVerified: true,
        loadProfileValid: false,
        admitted: false,
    })
})

test("report structure rejects malformed and contradictory statistics fail closed", () => {
    const cases = [
        ["null report", () => null],
        ["missing profile", value => { delete value.profile }],
        ["missing metadata", value => { delete value.metadata }],
        ["extra report field", value => { value.hostname = "builder.local" }],
        ["metadata claims identities are requests", value => {
            value.metadata.activeIdentitiesAreConcurrentRequests = true
        }],
        ["metadata claims production proportions", value => {
            value.metadata.entryDistributionNote = "production traffic proportions"
        }],
        ["metadata weight exceeds report precision", value => {
            value.metadata.entryDistribution[0].weight += 0.01
        }],
        ["NaN save count", value => { value.profile.independentSaves = Number.NaN }],
        ["negative active count", value => { value.profile.activeIdentities = -1 }],
        ["unsafe active count", value => {
            value.profile.activeIdentities = Number.MAX_SAFE_INTEGER + 1
        }],
        ["more active identities than saves", value => {
            value.profile.independentSaves = 599
        }],
        ["empty concurrency set", value => {
            value.profile.concurrencySteps = []
            value.steps = []
        }],
        ["duplicate declared concurrency", value => {
            value.profile.concurrencySteps[1] = 10
            value.steps[1].concurrency = 10
        }],
        ["zero concurrency", value => {
            value.profile.concurrencySteps[0] = 0
            value.steps[0].concurrency = 0
        }],
        ["sparse concurrency set", value => {
            delete value.profile.concurrencySteps[1]
        }],
        ["missing steps", value => { delete value.steps }],
        ["empty steps", value => { value.steps = [] }],
        ["sparse steps", value => { delete value.steps[1] }],
        ["duplicate executed concurrency", value => { value.steps[1].concurrency = 10 }],
        ["step does not match declaration", value => { value.steps[1].concurrency = 20 }],
        ["step requests are fractional", value => { value.steps[0].requests = 600.5 }],
        ["step requests disagree with entries", value => { value.steps[0].requests-- }],
        ["step errors disagree with entries", value => { value.steps[0].errors = 1 }],
        ["entry requests disagree with declared distribution", value => {
            value.steps[0].entries[0].requests++
            value.steps[0].entries[1].requests--
        }],
        ["entry errors hidden by step", value => {
            value.steps[0].entries[0].errors = 1
        }],
        ["entry errors exceed requests", value => {
            value.steps[0].entries[0].errors = 87
            value.steps[0].errors = 87
        }],
        ["entry requests are zero", value => {
            value.steps[0].entries[0].requests = 0
            value.steps[0].requests -= 86
        }],
        ["missing entry field", value => {
            delete value.steps[0].entries[0].behaviorSignatures
        }],
        ["empty behavior signatures", value => {
            value.steps[0].entries[0].behaviorSignatures = []
        }],
        ["non-string behavior signature", value => {
            value.steps[0].entries[0].behaviorSignatures = [null]
        }],
        ["sparse behavior signatures", value => {
            delete value.steps[0].entries[0].behaviorSignatures[0]
        }],
        ["sparse behavior signatures masked by an extra property", value => {
            const signatures = value.steps[0].entries[0].behaviorSignatures
            delete signatures[0]
            signatures.extra = "auth-stable"
        }],
        ["missing rollback result", value => {
            delete value.steps[0].entries[0].rollbackVerified
        }],
        ["non-boolean rollback result", value => {
            value.steps[0].entries[0].rollbackVerified = 1
        }],
        ["missing latency observation", value => {
            delete value.steps[0].latencyMs.p95
        }],
        ["missing event-loop observation", value => {
            delete value.steps[0].eventLoopDelayMs.max
        }],
        ["negative throughput", value => {
            value.steps[0].throughputPerSecond = -1
        }],
        ["missing entry SQL", value => {
            delete value.steps[0].entries[0].sql
        }],
        ["entry without SQL read evidence", value => {
            value.steps[0].entries[0].sql.readsMax = 0
        }],
        ["NaN latency observation", value => {
            value.steps[0].entries[0].latencyMs.p50 = Number.NaN
        }],
        ["infinite latency observation", value => {
            value.steps[0].latencyMs.p95 = Number.POSITIVE_INFINITY
        }],
        ["negative latency observation", value => {
            value.steps[0].latencyMs.p50 = -0.01
        }],
        ["contradictory latency percentiles", value => {
            value.steps[0].latencyMs = { p50: 8, p95: 7 }
        }],
    ]

    for (const [label, mutate] of cases) {
        const value = report()
        const replacement = mutate(value)
        assertClosed(replacement === undefined ? value : replacement, label)
    }
})

test("entry sets reject missing, duplicate, unknown, and multi-related names", () => {
    const cases = [
        ["missing", value => { value.steps[0].entries.pop() }],
        ["duplicate", value => { value.steps[0].entries[1].name = "auth" }],
        ["out of physical order", value => {
            ;[value.steps[0].entries[0], value.steps[0].entries[1]] = [
                value.steps[0].entries[1],
                value.steps[0].entries[0],
            ]
        }],
        ["unknown", value => { value.steps[0].entries[0].name = "profile" }],
        ...["multi", "hub", "tcp", "npc"].map(name => [name, value => {
            value.steps[0].entries[0].name = name
        }]),
    ]

    for (const [label, mutate] of cases) {
        const value = report()
        mutate(value)
        assertClosed(value, label)
    }
})

test("array validation rejects overridden methods and hidden keys fail closed", () => {
    function hide(array, key, value) {
        Object.defineProperty(array, key, { value })
    }

    const cases = [
        ["concurrency methods", value => {
            value.profile.concurrencySteps[0] = 0
            value.steps[0].concurrency = 0
            hide(value.profile.concurrencySteps, "every", () => true)
            hide(value.profile.concurrencySteps, "some", () => false)
        }],
        ["steps method", value => {
            hide(value.steps, "every", () => true)
        }],
        ["entries method", value => {
            value.steps[0].entries[1].name = "auth"
            hide(value.steps[0].entries, "map", () => [...ENTRY_NAMES])
        }],
        ["behavior signatures method", value => {
            value.steps[0].entries[0].behaviorSignatures[0] = null
            hide(value.steps[0].entries[0].behaviorSignatures, "every", () => true)
        }],
        ["concurrency accessor element", value => {
            const concurrency = value.profile.concurrencySteps[0]
            Object.defineProperty(value.profile.concurrencySteps, "0", {
                enumerable: true,
                get: () => concurrency,
            })
        }],
        ["concurrency symbol", value => {
            hide(value.profile.concurrencySteps, Symbol("hidden"), true)
        }],
        ["steps symbol", value => {
            hide(value.steps, Symbol("hidden"), true)
        }],
        ["entries symbol", value => {
            hide(value.steps[0].entries, Symbol("hidden"), true)
        }],
        ["behavior signatures symbol", value => {
            hide(value.steps[0].entries[0].behaviorSignatures, Symbol("hidden"), true)
        }],
    ]

    for (const [label, mutate] of cases) {
        const value = report()
        mutate(value)
        assertClosed(value, label)
    }
})

test("admission rejects errors, unstable behavior, and failed write rollbacks", () => {
    const withError = report()
    withError.steps[0].entries[0].errors = 1
    withError.steps[0].errors = 1
    assert.equal(validateReportStructure(withError), true)
    assert.equal(createAdmissionGate(withError).zeroErrors, false)

    const unstable = report()
    unstable.steps[1].entries[0].behaviorSignatures = ["auth-changed"]
    assert.equal(validateReportStructure(unstable), true)
    assert.equal(createAdmissionGate(unstable).behaviorStable, false)
    assert.equal(createAdmissionGate(unstable).admitted, false)

    const multipleSignatures = report()
    multipleSignatures.steps[0].entries[0].behaviorSignatures.push("auth-alternate")
    assert.equal(validateReportStructure(multipleSignatures), true)
    assert.equal(createAdmissionGate(multipleSignatures).behaviorStable, false)

    const stableMultipleSignatures = report()
    for (const step of stableMultipleSignatures.steps) {
        step.entries[1].behaviorSignatures = ["load-large", "load-new", "load-small"]
    }
    assert.equal(validateReportStructure(stableMultipleSignatures), true)
    assert.equal(createAdmissionGate(stableMultipleSignatures).behaviorStable, true)

    const missingOverlaySignature = report()
    for (const step of missingOverlaySignature.steps) {
        step.entries.find(item => item.name === "single-battle").behaviorSignatures = ["single-battle-new"]
    }
    assert.equal(createAdmissionGate(missingOverlaySignature).behaviorStable, true)
    assert.equal(createAdmissionGate(missingOverlaySignature).loadProfileValid, false)
    assert.equal(createAdmissionGate(missingOverlaySignature).admitted, false)

    const unexpectedExtraSignature = report()
    for (const step of unexpectedExtraSignature.steps) {
        step.entries.find(item => item.name === "auth").behaviorSignatures = ["auth-stable", "auth-alternate"]
    }
    assert.equal(createAdmissionGate(unexpectedExtraSignature).behaviorStable, true)
    assert.equal(createAdmissionGate(unexpectedExtraSignature).loadProfileValid, false)
    assert.equal(createAdmissionGate(unexpectedExtraSignature).admitted, false)

    for (const name of WRITE_ENTRY_NAMES) {
        const failedRollback = report()
        failedRollback.steps[0].entries.find(item => item.name === name).rollbackVerified = false
        assert.equal(createAdmissionGate(failedRollback).rollbackVerified, false, name)
        assert.equal(createAdmissionGate(failedRollback).admitted, false, name)
    }

    const readRollbacksNotRequired = report()
    for (const step of readRollbacksNotRequired.steps) {
        for (const item of step.entries) {
            if (!WRITE_ENTRY_NAMES.includes(item.name)) item.rollbackVerified = false
        }
    }
    assert.equal(createAdmissionGate(readRollbacksNotRequired).rollbackVerified, true)
    assert.equal(createAdmissionGate(readRollbacksNotRequired).admitted, true)
})

test("formal admission cannot pass on profile metadata alone", () => {
    const skippedRequests = report()
    for (const step of skippedRequests.steps) {
        step.entries[0].requests--
        step.requests--
    }

    assert.equal(validateReportStructure(skippedRequests), false)
    assert.equal(createAdmissionGate(skippedRequests).admitted, false)
})

test("formal admission requires the exact per-entry request distribution", () => {
    const skewed = report({ entryRequests: [594, 1, 1, 1, 1, 1, 1] })

    assert.equal(validateReportStructure(skewed), true)
    assert.equal(createAdmissionGate(skewed).loadProfileValid, false)
    assert.equal(createAdmissionGate(skewed).admitted, false)
})
