"use strict"

const crypto = require("node:crypto")
const { types: { isProxy } } = require("node:util")

const FORMAL_MULTI_PROFILE = Object.freeze({
    activeIdentities: 120,
    clientOwnedRooms: 30,
    concurrencySteps: Object.freeze([5, 10, 20]),
    hostOwnedRooms: 30,
    totalRooms: 60,
})
const SMOKE_MULTI_PROFILE = Object.freeze({
    activeIdentities: 2,
    clientOwnedRooms: 0,
    concurrencySteps: Object.freeze([1]),
    hostOwnedRooms: 1,
    totalRooms: 1,
})

const REPORT_FIELDS = Object.freeze(["schemaVersion", "profile", "steps"])
const PROFILE_FIELDS = Object.freeze([
    "activeIdentities",
    "clientOwnedRooms",
    "concurrencySteps",
    "hostOwnedRooms",
    "totalRooms",
])
const STEP_FIELDS = Object.freeze([
    "behaviorSignatures",
    "cleanup",
    "coexistence",
    "concurrency",
    "errors",
    "latencyMs",
    "players",
    "rooms",
    "settlement",
])
const ROOM_FIELDS = Object.freeze(["attempted", "clientOwned", "completed", "hostOwned"])
const PLAYER_FIELDS = Object.freeze(["attempted", "completed"])
const COEXISTENCE_FIELDS = Object.freeze(["attempted", "completed", "errors", "routes"])
const ROUTE_FIELDS = Object.freeze(["auth", "load", "mission"])
const SETTLEMENT_FIELDS = Object.freeze([
    "activeQuestsAfter",
    "duplicateFinishRejected",
    "errors",
])
const CLEANUP_FIELDS = Object.freeze([
    "activePeers",
    "activeProcesses",
    "portsReleased",
    "remainingRooms",
    "temporaryRootExists",
])
const LATENCY_FIELDS = Object.freeze(["p50", "p95", "p99"])
const BEHAVIOR_FIELDS = Object.freeze([
    "duplicateFinishRejected",
    "guestRewarded",
    "hostRewarded",
    "ownerSide",
])
const SIGNATURE_PATTERN = /^sha256:[a-f0-9]{64}$/
const CHECK_FAILURES = Object.freeze({
    profileValid: "profile does not match a supported multiplayer load profile",
    completionValid: "rooms, players, or step errors did not complete cleanly",
    coexistenceValid: "HTTP coexistence coverage did not complete cleanly",
    settlementValid: "multiplayer settlement did not complete cleanly",
    signaturesStable: "behavior signatures did not match the expected successful multiplayer outcomes",
    cleanupValid: "multiplayer processes, peers, rooms, ports, or temporary files leaked",
})

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
        return false
    }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasExactDataFields(value, expectedFields) {
    if (!isPlainObject(value)) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedFields.length) return false
    const expected = new Set(expectedFields)
    for (const key of keys) {
        if (typeof key !== "string" || !expected.has(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
}

function isDenseArray(value) {
    if (isProxy(value)
        || !Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false
    for (let index = 0; index < value.length; index++) {
        const key = String(index)
        if (!Object.hasOwn(value, key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return keys.every(key => key === "length"
        || (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/.test(key)
            && Number(key) < value.length))
}

function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0
}

function canonicalJson(value) {
    const ancestors = new WeakSet()

    function visit(current, path) {
        if (current === null || typeof current === "boolean" || typeof current === "string") {
            return JSON.stringify(current)
        }
        if (typeof current === "number") {
            if (!Number.isFinite(current)) throw new TypeError(`${path} must be a finite number`)
            return JSON.stringify(Object.is(current, -0) ? 0 : current)
        }
        if (typeof current !== "object") {
            throw new TypeError(`${path} contains unsupported ${typeof current}`)
        }
        if (isProxy(current)) throw new TypeError(`${path} must not contain a Proxy`)
        if (!Array.isArray(current) && !isPlainObject(current)) {
            throw new TypeError(`${path} must contain only arrays and plain objects`)
        }
        if (ancestors.has(current)) throw new TypeError(`${path} contains a circular reference`)

        ancestors.add(current)
        try {
            if (Array.isArray(current)) {
                if (!isDenseArray(current)) {
                    throw new TypeError(`${path} must be a dense JSON array`)
                }
                const items = []
                for (let index = 0; index < current.length; index++) {
                    items.push(visit(current[index], `${path}[${index}]`))
                }
                return `[${items.join(",")}]`
            }

            const keys = Reflect.ownKeys(current)
            for (const key of keys) {
                if (typeof key !== "string") throw new TypeError(`${path} contains a Symbol key`)
                const descriptor = Object.getOwnPropertyDescriptor(current, key)
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw new TypeError(`${path}.${key} must be an enumerable data value`)
                }
            }
            const fields = keys.sort().map(key => (
                `${JSON.stringify(key)}:${visit(current[key], `${path}.${key}`)}`
            ))
            return `{${fields.join(",")}}`
        } finally {
            ancestors.delete(current)
        }
    }

    return visit(value, "value")
}

function createBehaviorSignature(roomResult) {
    if (!hasExactDataFields(roomResult, BEHAVIOR_FIELDS)
        || (roomResult.ownerSide !== "host" && roomResult.ownerSide !== "client")
        || typeof roomResult.hostRewarded !== "boolean"
        || typeof roomResult.guestRewarded !== "boolean"
        || !isNonNegativeSafeInteger(roomResult.duplicateFinishRejected)) {
        throw new TypeError("room result is not a normalized multiplayer behavior result")
    }
    return `sha256:${crypto.createHash("sha256").update(canonicalJson(roomResult)).digest("hex")}`
}

function validProfile(profile) {
    if (!hasExactDataFields(profile, PROFILE_FIELDS)
        || !isPositiveSafeInteger(profile.activeIdentities)
        || !isNonNegativeSafeInteger(profile.clientOwnedRooms)
        || !isNonNegativeSafeInteger(profile.hostOwnedRooms)
        || !isPositiveSafeInteger(profile.totalRooms)
        || !Number.isSafeInteger(profile.clientOwnedRooms + profile.hostOwnedRooms)
        || profile.clientOwnedRooms + profile.hostOwnedRooms !== profile.totalRooms
        || !isDenseArray(profile.concurrencySteps)
        || profile.concurrencySteps.length === 0) {
        return false
    }
    let previous = 0
    for (const concurrency of profile.concurrencySteps) {
        if (!isPositiveSafeInteger(concurrency)
            || concurrency <= previous
            || concurrency > profile.activeIdentities) return false
        previous = concurrency
    }
    return true
}

function validCounterObject(value, fields) {
    return hasExactDataFields(value, fields)
        && fields.every(field => isNonNegativeSafeInteger(value[field]))
}

function validLatency(value) {
    return hasExactDataFields(value, LATENCY_FIELDS)
        && LATENCY_FIELDS.every(field => Number.isFinite(value[field])
            && value[field] >= 0
            && value[field] <= Number.MAX_SAFE_INTEGER)
        && value.p50 <= value.p95
        && value.p95 <= value.p99
}

function validStringArray(value) {
    return isDenseArray(value) && value.every(item => typeof item === "string")
}

function validSignatureArray(value) {
    if (!isDenseArray(value)
        || value.length === 0
        || !value.every(signature => typeof signature === "string"
            && SIGNATURE_PATTERN.test(signature))) return false
    for (let index = 1; index < value.length; index++) {
        if (value[index - 1] >= value[index]) return false
    }
    return true
}

function expectedBehaviorSignatures(profile) {
    return [
        ...(profile.hostOwnedRooms > 0 ? ["host"] : []),
        ...(profile.clientOwnedRooms > 0 ? ["client"] : []),
    ].map(ownerSide => createBehaviorSignature({
        ownerSide,
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 2,
    })).sort()
}

function validStep(step, concurrency) {
    return hasExactDataFields(step, STEP_FIELDS)
        && step.concurrency === concurrency
        && validCounterObject(step.rooms, ROOM_FIELDS)
        && validCounterObject(step.players, PLAYER_FIELDS)
        && hasExactDataFields(step.coexistence, COEXISTENCE_FIELDS)
        && isNonNegativeSafeInteger(step.coexistence.attempted)
        && isNonNegativeSafeInteger(step.coexistence.completed)
        && isNonNegativeSafeInteger(step.coexistence.errors)
        && validCounterObject(step.coexistence.routes, ROUTE_FIELDS)
        && validCounterObject(step.settlement, SETTLEMENT_FIELDS)
        && hasExactDataFields(step.cleanup, CLEANUP_FIELDS)
        && isNonNegativeSafeInteger(step.cleanup.activePeers)
        && isNonNegativeSafeInteger(step.cleanup.activeProcesses)
        && isNonNegativeSafeInteger(step.cleanup.remainingRooms)
        && typeof step.cleanup.portsReleased === "boolean"
        && typeof step.cleanup.temporaryRootExists === "boolean"
        && validSignatureArray(step.behaviorSignatures)
        && validLatency(step.latencyMs)
        && validStringArray(step.errors)
}

function inspectMultiHubReport(report) {
    if (!hasExactDataFields(report, REPORT_FIELDS)
        || report.schemaVersion !== 1
        || !validProfile(report.profile)
        || !isDenseArray(report.steps)
        || report.steps.length !== report.profile.concurrencySteps.length) {
        return null
    }
    for (let index = 0; index < report.steps.length; index++) {
        if (!validStep(report.steps[index], report.profile.concurrencySteps[index])) return null
    }
    if (!signaturesAreStable(report)) return null
    return report
}

function validateMultiHubReport(report) {
    try {
        return inspectMultiHubReport(report) !== null
    } catch {
        return false
    }
}

function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function profileMatches(actual, expected) {
    return actual.activeIdentities === expected.activeIdentities
        && actual.clientOwnedRooms === expected.clientOwnedRooms
        && actual.hostOwnedRooms === expected.hostOwnedRooms
        && actual.totalRooms === expected.totalRooms
        && arraysEqual(actual.concurrencySteps, expected.concurrencySteps)
}

function isSupportedProfile(profile) {
    return profileMatches(profile, FORMAL_MULTI_PROFILE)
        || profileMatches(profile, SMOKE_MULTI_PROFILE)
}

function hasOwnDataField(value, field) {
    if (!isPlainObject(value)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    return descriptor?.enumerable === true && "value" in descriptor
}

function hasNoUnknownFields(value, allowedFields) {
    if (!isPlainObject(value)) return false
    const allowed = new Set(allowedFields)
    return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.has(key))
}

function getAdmissionSteps(report) {
    if (!hasOwnDataField(report, "steps")) return null
    const steps = report.steps
    return isDenseArray(steps) && steps.length > 0 ? steps : null
}

function validAdmissionProfile(report) {
    return hasOwnDataField(report, "profile")
        && validProfile(report.profile)
        && isSupportedProfile(report.profile)
}

function completedCleanly(report) {
    if (!hasExactDataFields(report, REPORT_FIELDS)
        || report.schemaVersion !== 1
        || !validProfile(report.profile)
        || !isDenseArray(report.steps)
        || report.steps.length !== report.profile.concurrencySteps.length) return false
    const profile = report.profile
    return report.steps.every((step, index) => hasNoUnknownFields(step, STEP_FIELDS)
        && hasOwnDataField(step, "concurrency")
        && hasOwnDataField(step, "rooms")
        && hasOwnDataField(step, "players")
        && hasOwnDataField(step, "errors")
        && hasOwnDataField(step, "latencyMs")
        && step.concurrency === profile.concurrencySteps[index]
        && validCounterObject(step.rooms, ROOM_FIELDS)
        && validCounterObject(step.players, PLAYER_FIELDS)
        && validStringArray(step.errors)
        && validLatency(step.latencyMs)
        && step.errors.length === 0
        && step.rooms.attempted === profile.totalRooms
        && step.rooms.completed === profile.totalRooms
        && step.rooms.hostOwned === profile.hostOwnedRooms
        && step.rooms.clientOwned === profile.clientOwnedRooms
        && step.players.attempted === profile.activeIdentities
        && step.players.completed === profile.activeIdentities)
}

function coexistenceCompleted(report) {
    const steps = getAdmissionSteps(report)
    if (steps === null
        || !hasOwnDataField(report, "profile")
        || !validProfile(report.profile)) return false
    return steps.every((step, index) => {
        if (!hasOwnDataField(step, "coexistence")) return false
        const coexistence = step.coexistence
        if (!hasExactDataFields(coexistence, COEXISTENCE_FIELDS)
            || !isNonNegativeSafeInteger(coexistence.attempted)
            || !isNonNegativeSafeInteger(coexistence.completed)
            || !isNonNegativeSafeInteger(coexistence.errors)
            || !validCounterObject(coexistence.routes, ROUTE_FIELDS)) return false
        const routes = coexistence.routes
        const concurrency = report.profile.concurrencySteps[index]
        if (step.concurrency !== concurrency) return false
        const batches = Math.ceil(report.profile.totalRooms / concurrency)
        const expectedPerRoute = batches * 2
        const expectedTotal = batches * 6
        return coexistence.attempted === expectedTotal
            && coexistence.completed === expectedTotal
            && coexistence.errors === 0
            && routes.auth === expectedPerRoute
            && routes.load === expectedPerRoute
            && routes.mission === expectedPerRoute
    })
}

function settlementCompleted(report) {
    const steps = getAdmissionSteps(report)
    if (steps === null
        || !hasOwnDataField(report, "profile")
        || !validProfile(report.profile)) return false
    return steps.every(step => hasOwnDataField(step, "settlement")
        && validCounterObject(step.settlement, SETTLEMENT_FIELDS)
        && step.settlement.duplicateFinishRejected === report.profile.activeIdentities
        && step.settlement.activeQuestsAfter === 0
        && step.settlement.errors === 0)
}

function signaturesAreStable(report) {
    const steps = getAdmissionSteps(report)
    if (steps === null
        || !hasOwnDataField(report, "profile")
        || !validProfile(report.profile)
        || !steps.every(step => hasOwnDataField(step, "behaviorSignatures")
            && validSignatureArray(step.behaviorSignatures))) return false
    const expected = expectedBehaviorSignatures(report.profile)
    return steps.every(step => arraysEqual(step.behaviorSignatures, expected))
}

function cleanupCompleted(report) {
    const steps = getAdmissionSteps(report)
    if (steps === null) return false
    return steps.every(step => hasOwnDataField(step, "cleanup")
        && hasExactDataFields(step.cleanup, CLEANUP_FIELDS)
        && isNonNegativeSafeInteger(step.cleanup.activePeers)
        && isNonNegativeSafeInteger(step.cleanup.activeProcesses)
        && isNonNegativeSafeInteger(step.cleanup.remainingRooms)
        && typeof step.cleanup.portsReleased === "boolean"
        && typeof step.cleanup.temporaryRootExists === "boolean"
        && step.cleanup.activePeers === 0
        && step.cleanup.activeProcesses === 0
        && step.cleanup.remainingRooms === 0
        && step.cleanup.portsReleased === true
        && step.cleanup.temporaryRootExists === false)
}

function safeAdmissionCheck(check) {
    try {
        return check() === true
    } catch {
        return false
    }
}

function createMultiHubAdmission(report) {
    const checks = {
        profileValid: safeAdmissionCheck(() => validAdmissionProfile(report)),
        completionValid: safeAdmissionCheck(() => completedCleanly(report)),
        coexistenceValid: safeAdmissionCheck(() => coexistenceCompleted(report)),
        settlementValid: safeAdmissionCheck(() => settlementCompleted(report)),
        signaturesStable: safeAdmissionCheck(() => signaturesAreStable(report)),
        cleanupValid: safeAdmissionCheck(() => cleanupCompleted(report)),
    }
    Object.freeze(checks)
    const failures = Object.freeze(Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => CHECK_FAILURES[name]))
    return Object.freeze({ admitted: failures.length === 0, failures, checks })
}

module.exports = {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    canonicalJson,
    createBehaviorSignature,
    createMultiHubAdmission,
    validateMultiHubReport,
}
