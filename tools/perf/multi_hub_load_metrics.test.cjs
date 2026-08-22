"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    createBehaviorSignature,
    createMultiHubAdmission,
    validateMultiHubReport,
} = require("./multi_hub_load_metrics.cjs")

const HOST_SIGNATURE = createBehaviorSignature({
    ownerSide: "host",
    hostRewarded: true,
    guestRewarded: true,
    duplicateFinishRejected: 2,
})
const CLIENT_SIGNATURE = createBehaviorSignature({
    ownerSide: "client",
    hostRewarded: true,
    guestRewarded: true,
    duplicateFinishRejected: 2,
})
const ALTERNATE_CLIENT_SIGNATURE = createBehaviorSignature({
    ownerSide: "client",
    hostRewarded: true,
    guestRewarded: false,
    duplicateFinishRejected: 2,
})

function expectedBehaviorSignatures(profile) {
    return [
        ...(profile.hostOwnedRooms > 0 ? [HOST_SIGNATURE] : []),
        ...(profile.clientOwnedRooms > 0 ? [CLIENT_SIGNATURE] : []),
    ].sort()
}

function behaviorSignatures({ hostRewarded, guestRewarded, duplicateFinishRejected }) {
    return ["host", "client"].map(ownerSide => createBehaviorSignature({
        ownerSide,
        hostRewarded,
        guestRewarded,
        duplicateFinishRejected,
    })).sort()
}

function createStep(profile, concurrency, overrides = {}) {
    const coexistenceBatches = Math.ceil(profile.totalRooms / concurrency)
    const coexistenceAttempts = coexistenceBatches * 6
    const coexistenceRoutes = coexistenceBatches * 2
    const step = {
        concurrency,
        rooms: {
            attempted: profile.totalRooms,
            completed: profile.totalRooms,
            hostOwned: profile.hostOwnedRooms,
            clientOwned: profile.clientOwnedRooms,
        },
        players: {
            attempted: profile.activeIdentities,
            completed: profile.activeIdentities,
        },
        coexistence: {
            attempted: coexistenceAttempts,
            completed: coexistenceAttempts,
            errors: 0,
            routes: {
                auth: coexistenceRoutes,
                load: coexistenceRoutes,
                mission: coexistenceRoutes,
            },
        },
        settlement: {
            duplicateFinishRejected: profile.activeIdentities,
            activeQuestsAfter: 0,
            errors: 0,
        },
        cleanup: {
            activePeers: 0,
            activeProcesses: 0,
            remainingRooms: 0,
            portsReleased: true,
            temporaryRootExists: false,
        },
        behaviorSignatures: expectedBehaviorSignatures(profile),
        latencyMs: { p50: 1.25, p95: 2.5, p99: 4.75 },
        errors: [],
    }
    return { ...step, ...overrides }
}

function createReport(profile = FORMAL_MULTI_PROFILE) {
    return {
        schemaVersion: 1,
        profile: {
            activeIdentities: profile.activeIdentities,
            clientOwnedRooms: profile.clientOwnedRooms,
            concurrencySteps: [...profile.concurrencySteps],
            hostOwnedRooms: profile.hostOwnedRooms,
            totalRooms: profile.totalRooms,
        },
        steps: profile.concurrencySteps.map(concurrency => createStep(profile, concurrency)),
    }
}

function admissionForMutation(mutator, profile = FORMAL_MULTI_PROFILE) {
    const report = createReport(profile)
    mutator(report)
    return createMultiHubAdmission(report)
}

function assertFailureCoverage(admission) {
    const failedChecks = Object.values(admission.checks).filter(passed => !passed).length
    assert.equal(admission.failures.length, failedChecks)
    assert.equal(new Set(admission.failures).size, failedChecks)
}

function assertOnlyCheckFailed(admission, failedCheck) {
    for (const [name, passed] of Object.entries(admission.checks)) {
        assert.equal(passed, name !== failedCheck, name)
    }
    assert.equal(admission.admitted, false)
    assert.equal(admission.failures.length, 1)
    assertFailureCoverage(admission)
}

function assertSignatureRejection(report) {
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "signaturesStable")
}

function assertFrozenAdmission(admission) {
    assert.equal(Object.isFrozen(admission), true)
    assert.equal(Object.isFrozen(admission.checks), true)
    assert.equal(Object.isFrozen(admission.failures), true)
    assert.throws(() => { admission.admitted = !admission.admitted }, TypeError)
    assert.throws(() => { admission.checks.profileValid = false }, TypeError)
    assert.throws(() => { admission.failures.push("mutated") }, TypeError)
}

test("formal and smoke profiles are deeply immutable", () => {
    assert.deepEqual(FORMAL_MULTI_PROFILE, {
        activeIdentities: 120,
        clientOwnedRooms: 30,
        concurrencySteps: [5, 10, 20],
        hostOwnedRooms: 30,
        totalRooms: 60,
    })
    assert.deepEqual(SMOKE_MULTI_PROFILE, {
        activeIdentities: 2,
        clientOwnedRooms: 0,
        concurrencySteps: [1],
        hostOwnedRooms: 1,
        totalRooms: 1,
    })
    assert.equal(Object.isFrozen(FORMAL_MULTI_PROFILE), true)
    assert.equal(Object.isFrozen(FORMAL_MULTI_PROFILE.concurrencySteps), true)
    assert.equal(Object.isFrozen(SMOKE_MULTI_PROFILE), true)
    assert.equal(Object.isFrozen(SMOKE_MULTI_PROFILE.concurrencySteps), true)
    assert.throws(() => { FORMAL_MULTI_PROFILE.activeIdentities = 1 }, TypeError)
    assert.throws(() => { SMOKE_MULTI_PROFILE.concurrencySteps.push(2) }, TypeError)
})

test("formal and smoke reports validate and are admitted", () => {
    for (const profile of [FORMAL_MULTI_PROFILE, SMOKE_MULTI_PROFILE]) {
        const report = createReport(profile)
        assert.equal(validateMultiHubReport(report), true)
        assert.deepEqual(createMultiHubAdmission(report), {
            admitted: true,
            failures: [],
            checks: {
                profileValid: true,
                completionValid: true,
                coexistenceValid: true,
                settlementValid: true,
                signaturesStable: true,
                cleanupValid: true,
            },
        })
    }
})

test("admission results are deeply frozen on admitted and fail-closed paths", () => {
    assertFrozenAdmission(createMultiHubAdmission(createReport()))
    assertFrozenAdmission(createMultiHubAdmission(null))
})

test("admission rejects the wrong identity count and room ownership distribution", () => {
    const wrongIdentities = admissionForMutation(report => {
        report.profile.activeIdentities = 119
    })
    assert.equal(wrongIdentities.admitted, false)
    assert.equal(wrongIdentities.checks.profileValid, false)

    const wrongOwners = admissionForMutation(report => {
        report.steps[0].rooms.hostOwned--
        report.steps[0].rooms.clientOwned++
    })
    assert.equal(wrongOwners.admitted, false)
    assert.equal(wrongOwners.checks.completionValid, false)
})

test("validation rejects missing, duplicate, and out-of-order concurrency steps", () => {
    const missing = createReport()
    missing.steps.pop()
    assert.equal(validateMultiHubReport(missing), false)

    const duplicate = createReport()
    duplicate.profile.concurrencySteps[1] = duplicate.profile.concurrencySteps[0]
    duplicate.steps[1].concurrency = duplicate.steps[0].concurrency
    assert.equal(validateMultiHubReport(duplicate), false)

    const outOfOrder = createReport()
    outOfOrder.steps.reverse()
    assert.equal(validateMultiHubReport(outOfOrder), false)
})

test("admission rejects incomplete rooms and players plus TCP errors", () => {
    const incompleteRoom = admissionForMutation(report => {
        report.steps[0].rooms.completed--
    })
    const incompletePlayer = admissionForMutation(report => {
        report.steps[0].players.completed--
    })
    const tcpError = admissionForMutation(report => {
        report.steps[0].errors.push("TCP finish failed")
    })
    assert.equal(incompleteRoom.checks.completionValid, false)
    assert.equal(incompletePlayer.checks.completionValid, false)
    assert.equal(tcpError.checks.completionValid, false)
})

test("admission rejects HTTP coexistence errors and route coverage mismatches", () => {
    const httpError = admissionForMutation(report => {
        report.steps[0].coexistence.errors = 1
    })
    const missingRoute = admissionForMutation(report => {
        report.steps[0].coexistence.routes.auth = 0
    })
    const routeTotalMismatch = admissionForMutation(report => {
        report.steps[0].coexistence.routes.mission--
    })
    for (const admission of [httpError, missingRoute, routeTotalMismatch]) {
        assert.equal(admission.admitted, false)
        assert.equal(admission.checks.coexistenceValid, false)
    }
})

test("coexistence admission requires exactly six requests per room batch", () => {
    const formal = createReport()
    assert.deepEqual(formal.steps.map(step => step.coexistence), [
        { attempted: 72, completed: 72, errors: 0, routes: { auth: 24, load: 24, mission: 24 } },
        { attempted: 36, completed: 36, errors: 0, routes: { auth: 12, load: 12, mission: 12 } },
        { attempted: 18, completed: 18, errors: 0, routes: { auth: 6, load: 6, mission: 6 } },
    ])
    const smoke = createReport(SMOKE_MULTI_PROFILE)
    assert.deepEqual(smoke.steps[0].coexistence, {
        attempted: 6,
        completed: 6,
        errors: 0,
        routes: { auth: 2, load: 2, mission: 2 },
    })

    const routeImbalance = admissionForMutation(report => {
        report.steps[0].coexistence.routes.auth++
        report.steps[0].coexistence.routes.load--
    })
    const missingBatch = admissionForMutation(report => {
        report.steps[0].coexistence.attempted -= 6
        report.steps[0].coexistence.completed -= 6
        for (const route of ["auth", "load", "mission"]) {
            report.steps[0].coexistence.routes[route] -= 2
        }
    })
    const extraBatch = admissionForMutation(report => {
        report.steps[0].coexistence.attempted += 6
        report.steps[0].coexistence.completed += 6
        for (const route of ["auth", "load", "mission"]) {
            report.steps[0].coexistence.routes[route] += 2
        }
    })
    for (const admission of [routeImbalance, missingBatch, extraBatch]) {
        assertOnlyCheckFailed(admission, "coexistenceValid")
    }
})

test("admission rejects settlement errors, active quests, and wrong duplicate count", () => {
    const settlementError = admissionForMutation(report => {
        report.steps[0].settlement.errors = 1
    })
    const activeQuest = admissionForMutation(report => {
        report.steps[0].settlement.activeQuestsAfter = 1
    })
    const wrongDuplicateCount = admissionForMutation(report => {
        report.steps[0].settlement.duplicateFinishRejected--
    })
    for (const admission of [settlementError, activeQuest, wrongDuplicateCount]) {
        assert.equal(admission.admitted, false)
        assert.equal(admission.checks.settlementValid, false)
    }
})

test("formal report admits a stable sorted host and client signature set", () => {
    const report = createReport()
    assert.equal(report.steps[0].behaviorSignatures.length, 2)
    assert.equal(validateMultiHubReport(report), true)
    assert.equal(createMultiHubAdmission(report).checks.signaturesStable, true)
})

test("stable failure behavior signatures cannot be admitted", () => {
    const report = createReport()
    const failures = behaviorSignatures({
        hostRewarded: false,
        guestRewarded: false,
        duplicateFinishRejected: 0,
    })
    for (const step of report.steps) step.behaviorSignatures = [...failures]
    const admission = createMultiHubAdmission(report)
    assertSignatureRejection(report)
    assert.deepEqual(admission.failures, [
        "behavior signatures did not match the expected successful multiplayer outcomes",
    ])
})

test("zero duplicate rejection signatures conflict with successful settlement aggregate", () => {
    const report = createReport()
    const zeroDuplicate = behaviorSignatures({
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 0,
    })
    for (const step of report.steps) step.behaviorSignatures = [...zeroDuplicate]
    assert.equal(report.steps[0].settlement.duplicateFinishRejected, 120)
    assertSignatureRejection(report)
})

test("formal report rejects a host-only signature set", () => {
    const report = createReport()
    for (const step of report.steps) step.behaviorSignatures = [HOST_SIGNATURE]
    assertSignatureRejection(report)
})

test("formal report rejects duplicate behavior signatures", () => {
    const report = createReport()
    for (const step of report.steps) {
        step.behaviorSignatures = [HOST_SIGNATURE, HOST_SIGNATURE]
    }
    assertSignatureRejection(report)
})

test("formal report rejects behavior signature sets that differ between steps", () => {
    const report = createReport()
    report.steps[1].behaviorSignatures = [HOST_SIGNATURE, ALTERNATE_CLIENT_SIGNATURE].sort()
    assertSignatureRejection(report)
})

test("smoke report rejects an unexpected client behavior signature", () => {
    const report = createReport(SMOKE_MULTI_PROFILE)
    report.steps[0].behaviorSignatures = [HOST_SIGNATURE, CLIENT_SIGNATURE].sort()
    assertSignatureRejection(report)
})

test("formal report rejects an unsorted behavior signature set", () => {
    const report = createReport()
    report.steps[0].behaviorSignatures.reverse()
    assertSignatureRejection(report)
})

test("admission rejects every cleanup leak and unreleased ports", () => {
    const mutations = [
        report => { report.steps[0].cleanup.activePeers = 1 },
        report => { report.steps[0].cleanup.activeProcesses = 1 },
        report => { report.steps[0].cleanup.remainingRooms = 1 },
        report => { report.steps[0].cleanup.temporaryRootExists = true },
        report => { report.steps[0].cleanup.portsReleased = false },
    ]
    for (const mutate of mutations) {
        const admission = admissionForMutation(mutate)
        assert.equal(admission.admitted, false)
        assert.equal(admission.checks.cleanupValid, false)
    }
})

test("admission collects all independent failure reasons", () => {
    const admission = admissionForMutation(report => {
        report.profile.activeIdentities = 119
        report.steps[0].rooms.completed--
        report.steps[0].coexistence.errors = 1
        report.steps[0].settlement.activeQuestsAfter = 1
        report.steps[1].behaviorSignatures[0] = ALTERNATE_CLIENT_SIGNATURE
        report.steps[0].cleanup.activePeers = 1
    })
    assert.equal(admission.admitted, false)
    assert.equal(admission.failures.length, 6)
    assert.deepEqual(admission.checks, {
        profileValid: false,
        completionValid: false,
        coexistenceValid: false,
        settlementValid: false,
        signaturesStable: false,
        cleanupValid: false,
    })
})

test("admission keeps a supported profile valid when a concurrency step is missing", () => {
    const report = createReport()
    report.steps.pop()
    const admission = createMultiHubAdmission(report)
    assert.deepEqual(admission.checks, {
        profileValid: true,
        completionValid: false,
        coexistenceValid: true,
        settlementValid: true,
        signaturesStable: true,
        cleanupValid: true,
    })
    assert.equal(admission.admitted, false)
    assertFailureCoverage(admission)
})

test("admission evaluates valid steps independently from unsupported profile semantics", () => {
    const unsupportedProfile = {
        activeIdentities: 4,
        clientOwnedRooms: 1,
        concurrencySteps: [1],
        hostOwnedRooms: 1,
        totalRooms: 2,
    }
    const report = createReport(unsupportedProfile)
    assert.equal(validateMultiHubReport(report), true)
    const admission = createMultiHubAdmission(report)
    assert.deepEqual(admission.checks, {
        profileValid: false,
        completionValid: true,
        coexistenceValid: true,
        settlementValid: true,
        signaturesStable: true,
        cleanupValid: true,
    })
    assert.equal(admission.admitted, false)
    assertFailureCoverage(admission)
})

test("admission isolates a readable local structure error to its owning check", () => {
    const report = createReport()
    report.steps[0].rooms.unknown = true
    assert.equal(validateMultiHubReport(report), false)
    const admission = createMultiHubAdmission(report)
    assert.deepEqual(admission.checks, {
        profileValid: true,
        completionValid: false,
        coexistenceValid: true,
        settlementValid: true,
        signaturesStable: true,
        cleanupValid: true,
    })
    assert.equal(admission.admitted, false)
    assertFailureCoverage(admission)
})

test("missing cleanup fails only cleanup admission", () => {
    const report = createReport()
    delete report.steps[0].cleanup
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "cleanupValid")
})

test("missing settlement fails only settlement admission", () => {
    const report = createReport()
    delete report.steps[0].settlement
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "settlementValid")
})

test("missing coexistence fails only coexistence admission", () => {
    const report = createReport()
    delete report.steps[0].coexistence
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "coexistenceValid")
})

test("missing behavior signatures fails only signature admission", () => {
    const report = createReport()
    delete report.steps[0].behaviorSignatures
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "signaturesStable")
})

test("unknown step field fails only completion admission", () => {
    const report = createReport()
    report.steps[0].unknown = true
    assert.equal(validateMultiHubReport(report), false)
    assertOnlyCheckFailed(createMultiHubAdmission(report), "completionValid")
})

test("admission gives one failure for every false check on unreadable input", () => {
    const malicious = new Proxy({}, {
        ownKeys() { throw new Error("must not run") },
    })
    const admission = createMultiHubAdmission(malicious)
    assert.deepEqual(admission.checks, {
        profileValid: false,
        completionValid: false,
        coexistenceValid: false,
        settlementValid: false,
        signaturesStable: false,
        cleanupValid: false,
    })
    assert.equal(admission.admitted, false)
    assertFailureCoverage(admission)
})

test("validation rejects hostile inheritance, sparse arrays, and unknown fields", () => {
    const inherited = Object.assign(Object.create({ injected: true }), createReport())
    assert.doesNotThrow(() => validateMultiHubReport(inherited))
    assert.equal(validateMultiHubReport(inherited), false)

    const sparseSteps = createReport()
    delete sparseSteps.steps[1]
    assert.equal(validateMultiHubReport(sparseSteps), false)

    const sparseErrors = createReport()
    sparseErrors.steps[0].errors = new Array(1)
    assert.equal(validateMultiHubReport(sparseErrors), false)

    const inheritedSteps = createReport()
    Object.setPrototypeOf(
        inheritedSteps.steps,
        Object.assign(Object.create(Array.prototype), { injected: true }),
    )
    assert.equal(validateMultiHubReport(inheritedSteps), false)

    for (const mutate of [
        report => { report.unknown = true },
        report => { report.profile.unknown = true },
        report => { report.steps[0].unknown = true },
        report => { report.steps[0].rooms.unknown = true },
        report => { report.steps[0].coexistence.routes.unknown = true },
    ]) {
        const report = createReport()
        mutate(report)
        assert.equal(validateMultiHubReport(report), false)
    }
})

test("validation rejects unsafe counters, negative latency, and malformed hashes", () => {
    const unsafe = createReport()
    unsafe.steps[0].players.attempted = Number.MAX_SAFE_INTEGER + 1
    assert.equal(validateMultiHubReport(unsafe), false)

    const negativeLatency = createReport()
    negativeLatency.steps[0].latencyMs.p95 = -1
    assert.equal(validateMultiHubReport(negativeLatency), false)

    for (const signature of ["abc", `sha256:${"A".repeat(64)}`, `${"a".repeat(64)}`]) {
        const malformed = createReport()
        malformed.steps[0].behaviorSignatures[0] = signature
        assert.equal(validateMultiHubReport(malformed), false)
    }
})

test("validation rejects latency percentiles above the safe integer limit", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1
    for (const latencyMs of [
        { p50: unsafe, p95: unsafe, p99: unsafe },
        { p50: 1, p95: unsafe, p99: unsafe },
        { p50: 1, p95: 2, p99: unsafe },
    ]) {
        const report = createReport()
        report.steps[0].latencyMs = latencyMs
        assert.equal(validateMultiHubReport(report), false)
        assert.equal(createMultiHubAdmission(report).admitted, false)
    }
})

test("latency percentile order failures belong only to completion admission", () => {
    for (const latencyMs of [
        { p50: 3, p95: 2, p99: 4 },
        { p50: 1, p95: 4, p99: 3 },
    ]) {
        const report = createReport()
        report.steps[0].latencyMs = latencyMs
        assert.equal(validateMultiHubReport(report), false)
        assertOnlyCheckFailed(createMultiHubAdmission(report), "completionValid")
    }
})

test("signature validation rejects boxed and coercible strings without calling toString", () => {
    const boxed = createReport()
    boxed.steps[0].behaviorSignatures[0] = new String(HOST_SIGNATURE)
    assert.equal(validateMultiHubReport(boxed), false)

    let coercions = 0
    const coercible = createReport()
    coercible.steps[0].behaviorSignatures[0] = {
        toString() {
            coercions++
            return HOST_SIGNATURE
        },
    }
    assert.equal(validateMultiHubReport(coercible), false)
    assert.equal(coercions, 0)
})

test("report APIs fail closed for hostile values and proxy variants", () => {
    const throwing = {}
    Object.defineProperty(throwing, "schemaVersion", {
        enumerable: true,
        get() { throw new Error("hostile getter") },
    })
    const proxiedProfile = createReport()
    proxiedProfile.profile = new Proxy(proxiedProfile.profile, {})
    const proxiedSteps = createReport()
    proxiedSteps.steps = new Proxy(proxiedSteps.steps, {})
    const proxiedRooms = createReport()
    proxiedRooms.steps[0].rooms = new Proxy(proxiedRooms.steps[0].rooms, {})
    const revokedObject = Proxy.revocable(createReport(), {
        ownKeys() { throw new Error("revoked object trap") },
    })
    const revokedArray = Proxy.revocable([], {
        get() { throw new Error("revoked array trap") },
    })
    revokedObject.revoke()
    revokedArray.revoke()

    const variants = [
        null,
        undefined,
        [],
        throwing,
        new Proxy(createReport(), {}),
        new Proxy({}, { ownKeys() { throw new Error("hostile proxy") } }),
        proxiedProfile,
        proxiedSteps,
        proxiedRooms,
        revokedObject.proxy,
        revokedArray.proxy,
    ]
    for (const value of variants) {
        assert.doesNotThrow(() => validateMultiHubReport(value))
        assert.equal(validateMultiHubReport(value), false)
        assert.doesNotThrow(() => createMultiHubAdmission(value))
        assert.equal(createMultiHubAdmission(value).admitted, false)
    }
})

test("profile proxy cannot present different descriptor and read values", () => {
    const report = createReport(SMOKE_MULTI_PROFILE)
    report.profile = new Proxy(report.profile, {
        get(target, property, receiver) {
            if (property === "activeIdentities") return 2
            return Reflect.get(target, property, receiver)
        },
        getOwnPropertyDescriptor(target, property) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
            if (property === "activeIdentities") return { ...descriptor, value: 999 }
            return descriptor
        },
    })
    assert.equal(validateMultiHubReport(report), false)
    assert.equal(createMultiHubAdmission(report).admitted, false)
})

test("proxy cannot hide an unknown report field", () => {
    const report = createReport()
    const target = { ...report.profile, unknown: true }
    report.profile = new Proxy(target, {
        ownKeys() {
            return Reflect.ownKeys(target).filter(key => key !== "unknown")
        },
    })
    assert.equal(validateMultiHubReport(report), false)
    assert.equal(createMultiHubAdmission(report).admitted, false)
})
