#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { isDeepStrictEqual, types: { isProxy } } = require("node:util")

const {
    assertDistinctOutputPaths,
    atomicWriteFile,
    serializeError,
    snapshotJsonValue,
} = require("./full_server_acceptance_safety.cjs")

const {
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_CONCURRENCY_STEPS,
    FORMAL_INDEPENDENT_SAVES,
    validateReportStructure,
} = require("./non_multi_mixed_metrics.cjs")
const {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    createMultiHubAdmission,
    validateMultiHubReport,
} = require("./multi_hub_load_metrics.cjs")

const REFERENCE_PATH = path.join(__dirname, "__snapshots__", "full_server_acceptance_reference.json")
const MAX_REGRESSION_RATIO = 1.2
const SMOKE_NON_MULTI_PROFILE = Object.freeze({
    independentSaves: 7,
    activeIdentities: 7,
    concurrencySteps: Object.freeze([2]),
})
const FORMAL_NON_MULTI_PROFILE = Object.freeze({
    independentSaves: FORMAL_INDEPENDENT_SAVES,
    activeIdentities: FORMAL_ACTIVE_IDENTITIES,
    concurrencySteps: FORMAL_CONCURRENCY_STEPS,
})
const PROFILE_IDENTIFIERS = Object.freeze({
    formal: Object.freeze({
        nonMulti: Object.freeze({ version: 1, name: "non-multi-mixed-formal-v1" }),
        multi: Object.freeze({ version: 1, name: "multi-hub-load-formal-v1" }),
    }),
    smoke: Object.freeze({
        nonMulti: Object.freeze({ version: 1, name: "non-multi-mixed-smoke-v1" }),
        multi: Object.freeze({ version: 1, name: "multi-hub-load-smoke-v1" }),
    }),
})

function copyProfiles(formal) {
    const source = formal ? PROFILE_IDENTIFIERS.formal : PROFILE_IDENTIFIERS.smoke
    return {
        nonMulti: { ...source.nonMulti },
        multi: { ...source.multi },
    }
}

function parsePositiveSafeInteger(value, flag) {
    if (!/^[1-9][0-9]*$/.test(value ?? "")) {
        throw new Error(`${flag} requires a positive safe integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${flag} requires a positive safe integer`)
    }
    return parsed
}

function parseArgs(argv) {
    let formal = false
    let rounds = null
    let output = null
    let writeReference = null
    const seen = new Set()
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (!["--formal", "--rounds", "--output", "--write-reference"].includes(argument)) {
            throw new Error(`unknown argument: ${argument}`)
        }
        if (seen.has(argument)) throw new Error(`${argument} may only be specified once`)
        seen.add(argument)
        if (argument === "--formal") {
            formal = true
            continue
        }
        const value = argv[++index]
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${argument} requires a value`)
        }
        if ((argument === "--output" || argument === "--write-reference") && value.length === 0) {
            throw new Error(`${argument} requires a non-empty path`)
        }
        if (argument === "--rounds") rounds = parsePositiveSafeInteger(value, argument)
        if (argument === "--output") output = value
        if (argument === "--write-reference") writeReference = value
    }
    rounds ??= formal ? 3 : 1
    if (writeReference !== null && (!formal || rounds !== 3)) {
        throw new Error("--write-reference requires --formal with exactly 3 rounds")
    }
    if (output !== null && writeReference !== null
        && path.resolve(output) === path.resolve(writeReference)) {
        throw new Error("--output and --write-reference require distinct paths")
    }
    return { formal, rounds, output, writeReference }
}

function createMachineFingerprint({
    platform = os.platform,
    arch = os.arch,
    cpus = os.cpus,
    nodeVersion = process.version,
} = {}) {
    const cpuList = cpus()
    const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/, "").split(".")[0], 10)
    return {
        platform: platform(),
        arch: arch(),
        nodeMajor,
        cpuModel: typeof cpuList[0]?.model === "string" ? cpuList[0].model : "unknown",
        logicalCpuCount: cpuList.length,
    }
}

function median(values) {
    if (!Array.isArray(values) || values.length === 0
        || values.some(value => !Number.isFinite(value))) {
        throw new TypeError("median requires finite values")
    }
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) return sorted[middle]
    const left = sorted[middle - 1]
    const right = sorted[middle]
    const distance = right - left
    return Number.isFinite(distance) ? left + distance / 2 : left / 2 + right / 2
}

function extractP95(report, child) {
    try {
        if (!Array.isArray(report?.steps) || report.steps.length === 0) return null
        const values = report.steps.map(step => step?.latencyMs?.p95)
        if (values.some(value => !Number.isFinite(value) || value < 0)) return null
        if (child !== "nonMulti" && child !== "multi") return null
        return Math.max(...values)
    } catch {
        return null
    }
}

function profileMatches(actual, expected) {
    return isDeepStrictEqual(actual, {
        ...expected,
        concurrencySteps: [...expected.concurrencySteps],
    })
}

function hasExactOwnDataFields(value, fields) {
    try {
        if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
            return false
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return false
        const keys = Reflect.ownKeys(value)
        if (keys.length !== fields.length) return false
        const expected = new Set(fields)
        return keys.every(key => {
            if (typeof key !== "string" || !expected.has(key)) return false
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            return descriptor?.enumerable === true && "value" in descriptor
        })
    } catch {
        return false
    }
}

function isDensePlainArray(value, expectedLength = null) {
    try {
        if (!Array.isArray(value) || isProxy(value)
            || Object.getPrototypeOf(value) !== Array.prototype) return false
        if (expectedLength !== null && value.length !== expectedLength) return false
        const keys = Reflect.ownKeys(value)
        if (keys.length !== value.length + 1 || !keys.includes("length")) return false
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
            if (!descriptor?.enumerable || !("value" in descriptor)) return false
        }
        return keys.every(key => key === "length"
            || (typeof key === "string"
                && /^(?:0|[1-9][0-9]*)$/.test(key)
                && Number(key) < value.length))
    } catch {
        return false
    }
}

function healthySmokeNonMultiGate(gate) {
    return gate?.reportStructureValid === true
        && gate.zeroErrors === true
        && gate.behaviorStable === true
        && gate.rollbackVerified === true
        && gate.loadProfileValid === false
        && gate.admitted === false
}

function inspectNonMultiChild(report, formal) {
    try {
        const expected = formal ? FORMAL_NON_MULTI_PROFILE : SMOKE_NON_MULTI_PROFILE
        const valid = hasExactOwnDataFields(report, ["metadata", "profile", "steps", "gate"])
            && isDensePlainArray(report.steps)
            && validateReportStructure(report)
            && profileMatches(report.profile, expected)
        const admitted = valid
            && (report.gate.admitted === true || (!formal && healthySmokeNonMultiGate(report.gate)))
        return { valid, admitted }
    } catch {
        return { valid: false, admitted: false }
    }
}

function inspectMultiChild(report, formal) {
    try {
        if (!hasExactOwnDataFields(report, ["schemaVersion", "profile", "steps", "gate"])
            || !isDensePlainArray(report.steps)) return { valid: false, admitted: false }
        const core = {
            schemaVersion: report.schemaVersion,
            profile: report.profile,
            steps: report.steps,
        }
        const expectedProfile = formal ? FORMAL_MULTI_PROFILE : SMOKE_MULTI_PROFILE
        const expectedGate = createMultiHubAdmission(core)
        const valid = validateMultiHubReport(core)
            && profileMatches(report.profile, expectedProfile)
            && isDeepStrictEqual(report.gate, expectedGate)
        return { valid, admitted: valid && expectedGate.admitted === true }
    } catch {
        return { valid: false, admitted: false }
    }
}

function nonMultiAdmitted(report, formal) {
    return inspectNonMultiChild(report, formal).admitted
}

function multiAdmitted(report, formal) {
    return inspectMultiChild(report, formal).admitted
}

function invalidChildPlaceholder(child) {
    const label = child === "nonMulti" ? "non-multi" : "multi"
    return {
        invalid: true,
        error: { name: "Error", message: `invalid ${label} child report` },
    }
}

async function captureChild(child, runner, formal) {
    try {
        const report = await runner({ formal })
        try {
            return { report: snapshotJsonValue(report), error: null }
        } catch {
            return { report: null, error: null }
        }
    } catch (error) {
        return { report: null, error: { child, error: serializeError(error) } }
    }
}

async function defaultRunNonMulti({ formal }) {
    const workload = require("./non_multi_mixed_workload.cjs")
    return workload.runNonMultiMixedWorkload({
        profile: formal ? workload.FORMAL_PROFILE : workload.DEFAULT_PROFILE,
    })
}

async function defaultRunMulti({ formal }) {
    const workload = require("./multi_hub_load_workload.cjs")
    const profile = formal ? FORMAL_MULTI_PROFILE : SMOKE_MULTI_PROFILE
    return workload.runMultiHubLoadWorkload({ profile })
}

function defaultReadReference() {
    try {
        return JSON.parse(fs.readFileSync(REFERENCE_PATH, "utf8"))
    } catch (error) {
        if (error?.code === "ENOENT") return null
        throw error
    }
}

function exactKeys(value, fields) {
    return hasExactOwnDataFields(value, fields)
}

function validFingerprint(value) {
    return exactKeys(value, ["platform", "arch", "nodeMajor", "cpuModel", "logicalCpuCount"])
        && typeof value.platform === "string"
        && typeof value.arch === "string"
        && Number.isSafeInteger(value.nodeMajor)
        && value.nodeMajor > 0
        && typeof value.cpuModel === "string"
        && Number.isSafeInteger(value.logicalCpuCount)
        && value.logicalCpuCount >= 0
}

function validProfileIdentifiers(value) {
    if (!exactKeys(value, ["nonMulti", "multi"])) return false
    return [value.nonMulti, value.multi].every(item => exactKeys(item, ["version", "name"])
        && Number.isSafeInteger(item.version)
        && item.version > 0
        && typeof item.name === "string"
        && item.name.length > 0)
}

function validReference(value) {
    return exactKeys(value, ["fingerprint", "profiles", "mediansMs"])
        && validFingerprint(value.fingerprint)
        && validProfileIdentifiers(value.profiles)
        && exactKeys(value.mediansMs, ["nonMultiP95", "multiP95"])
        && Number.isFinite(value.mediansMs.nonMultiP95)
        && value.mediansMs.nonMultiP95 > 0
        && Number.isFinite(value.mediansMs.multiP95)
        && value.mediansMs.multiP95 > 0
}

function roundRatio(value) {
    if (!Number.isFinite(value) || value < 0) return null
    if (value >= 1e21) return value
    const rounded = Number(value.toFixed(6))
    return Number.isFinite(rounded) ? rounded : null
}

function finiteRatio(observed, reference) {
    if (!Number.isFinite(observed) || observed < 0
        || !Number.isFinite(reference) || reference <= 0) return null
    const ratio = observed / reference
    return Number.isFinite(ratio) && ratio >= 0 ? ratio : null
}

function collectObservedMedians(rounds) {
    const nonMulti = rounds.map(round => extractP95(round.nonMulti, "nonMulti"))
    const multi = rounds.map(round => extractP95(round.multi, "multi"))
    return {
        nonMultiP95: nonMulti.some(value => value === null) ? null : median(nonMulti),
        multiP95: multi.some(value => value === null) ? null : median(multi),
    }
}

async function runFullServerAcceptance({
    formal = false,
    rounds = formal ? 3 : 1,
    runNonMulti = defaultRunNonMulti,
    runMulti = defaultRunMulti,
    readReference = defaultReadReference,
} = {}) {
    if (!Number.isSafeInteger(rounds) || rounds <= 0) {
        throw new TypeError("rounds must be a positive safe integer")
    }
    const fingerprint = createMachineFingerprint()
    const profiles = copyProfiles(formal)
    const results = []
    const failures = []
    for (let index = 0; index < rounds; index++) {
        const nonMultiResult = await captureChild("nonMulti", runNonMulti, formal)
        const multiResult = await captureChild("multi", runMulti, formal)
        const errors = [nonMultiResult.error, multiResult.error].filter(Boolean)
        const nonMultiStatus = inspectNonMultiChild(nonMultiResult.report, formal)
        const multiStatus = inspectMultiChild(multiResult.report, formal)
        const nonMultiPassed = nonMultiStatus.admitted
        const multiPassed = multiStatus.admitted
        const admitted = nonMultiPassed && multiPassed && errors.length === 0
        if (!nonMultiPassed) failures.push(`round ${index + 1} non-multi child rejected or malformed`)
        if (!multiPassed) failures.push(`round ${index + 1} multi child rejected or malformed`)
        results.push({
            round: index + 1,
            nonMulti: nonMultiStatus.valid
                ? nonMultiResult.report
                : invalidChildPlaceholder("nonMulti"),
            multi: multiStatus.valid ? multiResult.report : invalidChildPlaceholder("multi"),
            errors,
            structural: { nonMultiAdmitted: nonMultiPassed, multiAdmitted: multiPassed, admitted },
        })
    }

    const observedMediansMs = collectObservedMedians(results)
    let reference = null
    let referenceError = null
    try {
        reference = await readReference()
    } catch (error) {
        referenceError = serializeError(error)
    }
    const referenceUsable = validReference(reference)
    const rawRatios = referenceUsable
        && observedMediansMs.nonMultiP95 !== null
        && observedMediansMs.multiP95 !== null
        ? {
            nonMulti: finiteRatio(
                observedMediansMs.nonMultiP95,
                reference.mediansMs.nonMultiP95,
            ),
            multi: finiteRatio(observedMediansMs.multiP95, reference.mediansMs.multiP95),
        }
        : { nonMulti: null, multi: null }
    const observedRatios = {
        nonMulti: rawRatios.nonMulti === null ? null : roundRatio(rawRatios.nonMulti),
        multi: rawRatios.multi === null ? null : roundRatio(rawRatios.multi),
    }
    const referenceComparable = formal
        && rounds === 3
        && referenceUsable
        && isDeepStrictEqual(fingerprint, reference.fingerprint)
        && isDeepStrictEqual(profiles, reference.profiles)
    const latencyAdmitted = !referenceComparable
        || (rawRatios.nonMulti !== null
            && rawRatios.multi !== null
            && rawRatios.nonMulti <= MAX_REGRESSION_RATIO
            && rawRatios.multi <= MAX_REGRESSION_RATIO)
    const structuralAdmitted = results.every(round => round.structural.admitted)
    if (!latencyAdmitted) failures.push("same-machine p95 regression exceeded 20 percent")
    return {
        schemaVersion: 1,
        formal,
        roundsRequested: rounds,
        fingerprint,
        profiles,
        rounds: results,
        latency: {
            observedMediansMs,
            observedRatios,
            referenceError,
        },
        gate: {
            structuralAdmitted,
            referenceComparable,
            latencyAdmitted,
            admitted: structuralAdmitted && latencyAdmitted,
            failures,
        },
    }
}

function createReference(report, { currentFingerprint = createMachineFingerprint() } = {}) {
    if (report?.formal !== true) throw new Error("reference requires a formal report")
    if (!isDensePlainArray(report.rounds, 3) || report.roundsRequested !== 3) {
        throw new Error("reference requires exactly 3 dense formal rounds")
    }
    if (!validFingerprint(report.fingerprint)
        || !isDeepStrictEqual(report.fingerprint, currentFingerprint)
        || !isDeepStrictEqual(report.profiles, copyProfiles(true))) {
        throw new Error("reference requires the current machine fingerprint and formal profiles")
    }
    for (let index = 0; index < report.rounds.length; index++) {
        const round = report.rounds[index]
        if (!Array.isArray(round?.errors)
            || round.errors.length !== 0
            || !nonMultiAdmitted(round.nonMulti, true)
            || !multiAdmitted(round.multi, true)) {
            throw new Error("reference requires three admitted child report pairs")
        }
    }
    const mediansMs = collectObservedMedians(report.rounds)
    const reference = {
        fingerprint: { ...report.fingerprint },
        profiles: {
            nonMulti: { ...report.profiles.nonMulti },
            multi: { ...report.profiles.multi },
        },
        mediansMs,
    }
    if (!validReference(reference)) throw new Error("reference contains invalid measurements")
    return reference
}

async function runCli({
    argv = process.argv.slice(2),
    runAcceptance = runFullServerAcceptance,
    writeStdout = value => process.stdout.write(value),
    fileSystem = fs,
} = {}) {
    const options = parseArgs(argv)
    assertDistinctOutputPaths(options.output, options.writeReference, fileSystem)
    const report = await runAcceptance({ formal: options.formal, rounds: options.rounds })
    const output = `${JSON.stringify(report, null, 2)}\n`
    const referenceOutput = options.writeReference === null
        ? null
        : `${JSON.stringify(createReference(report), null, 2)}\n`
    if (options.output !== null) atomicWriteFile(options.output, output, fileSystem)
    if (options.writeReference !== null) {
        atomicWriteFile(options.writeReference, referenceOutput, fileSystem)
    }
    writeStdout(output)
    return report.gate?.admitted === true ? 0 : 1
}

if (require.main === module) {
    runCli().then(code => { process.exitCode = code }).catch(() => {
        process.stderr.write("full-server acceptance failed\n")
        process.exitCode = 1
    })
}

module.exports = {
    MAX_REGRESSION_RATIO,
    PROFILE_IDENTIFIERS,
    REFERENCE_PATH,
    createMachineFingerprint,
    createReference,
    extractP95,
    median,
    parseArgs,
    runCli,
    runFullServerAcceptance,
}
