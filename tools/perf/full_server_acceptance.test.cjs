"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { createAdmissionGate } = require("./non_multi_mixed_metrics.cjs")
const {
    formalRun,
    multiReport,
    nonMultiReport,
} = require("./full_server_acceptance_test_helpers.cjs")

const acceptancePath = path.join(__dirname, "full_server_acceptance.cjs")
const acceptance = require(acceptancePath)

test("parseArgs defaults smoke to one round and formal to three", () => {
    assert.deepEqual(acceptance.parseArgs([]), {
        formal: false,
        rounds: 1,
        output: null,
        writeReference: null,
    })
    assert.deepEqual(acceptance.parseArgs(["--formal"]), {
        formal: true,
        rounds: 3,
        output: null,
        writeReference: null,
    })
    assert.deepEqual(acceptance.parseArgs(["--rounds", "2", "--output", "full.json"]), {
        formal: false,
        rounds: 2,
        output: "full.json",
        writeReference: null,
    })
})

test("parseArgs rejects unknown, duplicate, missing, and invalid values", () => {
    for (const argv of [
        ["--unknown"],
        ["--formal", "--formal"],
        ["--rounds", "1", "--rounds", "2"],
        ["--output", "a", "--output", "b"],
        ["--write-reference", "a", "--write-reference", "b"],
        ["--rounds"],
        ["--output"],
        ["--write-reference"],
        ["--rounds", "--formal"],
        ["--rounds", "0"],
        ["--rounds", "-1"],
        ["--rounds", "1.5"],
        ["--rounds", "9007199254740992"],
        ["--rounds", "1x"],
        ["--write-reference", "reference.json"],
        ["--formal", "--rounds", "2", "--write-reference", "reference.json"],
    ]) {
        assert.throws(() => acceptance.parseArgs(argv), Error, argv.join(" "))
    }
})

test("parseArgs rejects empty and normalized-identical output paths", () => {
    assert.throws(() => acceptance.parseArgs(["--output", ""]), /non-empty|path/i)
    assert.throws(
        () => acceptance.parseArgs(["--formal", "--write-reference", ""]),
        /non-empty|path/i,
    )
    const relative = path.join("reports", "full-server.json")
    assert.throws(
        () => acceptance.parseArgs([
            "--formal",
            "--output", relative,
            "--write-reference", path.resolve(relative),
        ]),
        /distinct|same|different/i,
    )
})

test("loading the combiner is silent", () => {
    const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", acceptancePath], {
        encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
})

test("machine fingerprint contains only the allowed stable fields", () => {
    const fingerprint = acceptance.createMachineFingerprint({
        platform: () => "linux",
        arch: () => "arm64",
        cpus: () => [{ model: "Example CPU" }, { model: "Example CPU" }],
        nodeVersion: "v22.14.0",
    })
    assert.deepEqual(fingerprint, {
        platform: "linux",
        arch: "arm64",
        nodeMajor: 22,
        cpuModel: "Example CPU",
        logicalCpuCount: 2,
    })
    assert.deepEqual(Object.keys(fingerprint).sort(), [
        "arch", "cpuModel", "logicalCpuCount", "nodeMajor", "platform",
    ])
})

test("an empty CPU list produces a valid zero-logical-CPU fingerprint", async () => {
    const fingerprint = acceptance.createMachineFingerprint({
        platform: () => "linux",
        arch: () => "x64",
        cpus: () => [],
        nodeVersion: "v22.14.0",
    })
    assert.deepEqual(fingerprint, {
        platform: "linux",
        arch: "x64",
        nodeMajor: 22,
        cpuModel: "unknown",
        logicalCpuCount: 0,
    })
    const report = (await formalRun()).report
    report.fingerprint = fingerprint
    assert.deepEqual(
        acceptance.createReference(report, { currentFingerprint: fingerprint }).fingerprint,
        fingerprint,
    )
})

test("formal rounds preserve child reports and run non-multi before multi", async () => {
    const { calls, report } = await formalRun({
        nonMultiP95: [100, 300, 200],
        multiP95: [30, 10, 20],
    })
    assert.deepEqual(calls, [
        "non-1-true", "multi-1-true",
        "non-2-true", "multi-2-true",
        "non-3-true", "multi-3-true",
    ])
    assert.equal(report.rounds.length, 3)
    assert.equal(report.rounds[0].nonMulti.steps[0].latencyMs.p95, 100)
    assert.equal(report.rounds[2].multi.steps[0].latencyMs.p95, 20)
    assert.deepEqual(report.latency.observedMediansMs, {
        nonMultiP95: 200,
        multiP95: 20,
    })
    assert.equal(report.gate.structuralAdmitted, true)
    assert.equal(report.gate.referenceComparable, false)
    assert.equal(report.gate.admitted, true)
})

test("smoke accepts the healthy non-formal child profile", async () => {
    const report = await acceptance.runFullServerAcceptance({
        formal: false,
        rounds: 1,
        runNonMulti: async ({ formal }) => nonMultiReport({ formal }),
        runMulti: async ({ formal }) => multiReport({ formal }),
        readReference: async () => null,
    })
    assert.equal(report.rounds[0].nonMulti.gate.loadProfileValid, false)
    assert.equal(report.rounds[0].nonMulti.gate.admitted, false)
    assert.equal(report.gate.structuralAdmitted, true)
    assert.equal(report.gate.admitted, true)
})

test("a rejected child rejects the full structural gate", async () => {
    const rejected = nonMultiReport()
    rejected.steps[0].errors = 1
    rejected.steps[0].entries[0].errors = 1
    const core = { metadata: rejected.metadata, profile: rejected.profile, steps: rejected.steps }
    rejected.gate = createAdmissionGate(core)
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 1,
        runNonMulti: async () => rejected,
        runMulti: async () => multiReport(),
        readReference: async () => null,
    })
    assert.equal(report.rounds[0].nonMulti.gate.admitted, false)
    assert.equal(report.gate.structuralAdmitted, false)
    assert.equal(report.gate.admitted, false)
})

test("malformed child reports fail closed even when they claim admission", async () => {
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 1,
        runNonMulti: async () => ({ gate: { admitted: true } }),
        runMulti: async () => multiReport(),
        readReference: async () => null,
    })
    assert.deepEqual(report.rounds[0].nonMulti, {
        invalid: true,
        error: { name: "Error", message: "invalid non-multi child report" },
    })
    assert.equal(report.gate.structuralAdmitted, false)
    assert.match(report.gate.failures.join(" "), /non-multi/i)
})

test("hostile top-level child keys and prototypes fail closed symmetrically", async () => {
    const mutations = [
        child => Object.assign(Object.create({ inheritedUnknown: true }), child),
        child => {
            child[Symbol("unknown")] = true
            return child
        },
        child => ({ ...child, ownUnknown: true }),
    ]
    for (const childName of ["nonMulti", "multi"]) {
        for (const mutate of mutations) {
            const hostile = mutate(childName === "nonMulti" ? nonMultiReport() : multiReport())
            const report = await acceptance.runFullServerAcceptance({
                formal: true,
                rounds: 1,
                runNonMulti: async () => childName === "nonMulti" ? hostile : nonMultiReport(),
                runMulti: async () => childName === "multi" ? hostile : multiReport(),
                readReference: async () => null,
            })
            assert.equal(report.rounds[0].structural[`${childName}Admitted`], false, childName)
            assert.equal(report.gate.structuralAdmitted, false, childName)
        }
    }
})

test("transparent proxies and custom steps prototypes fail closed for both children", async () => {
    const mutations = [
        child => new Proxy(child, {}),
        child => {
            child.steps = new Proxy(child.steps, {})
            return child
        },
        child => {
            Object.setPrototypeOf(child.steps, Object.assign(Object.create(Array.prototype), {
                inheritedUnknown: true,
            }))
            return child
        },
    ]
    for (const childName of ["nonMulti", "multi"]) {
        for (const mutate of mutations) {
            const hostile = mutate(childName === "nonMulti" ? nonMultiReport() : multiReport())
            const report = await acceptance.runFullServerAcceptance({
                formal: true,
                rounds: 1,
                runNonMulti: async () => childName === "nonMulti" ? hostile : nonMultiReport(),
                runMulti: async () => childName === "multi" ? hostile : multiReport(),
                readReference: async () => null,
            })
            assert.equal(report.rounds[0].structural[`${childName}Admitted`], false, childName)
        }
    }
})

test("deep hostile child values are snapshotted fail-closed without invoking accessors", async () => {
    const mutations = [
        child => {
            Object.defineProperty(child.steps[0].latencyMs, "toJSON", {
                enumerable: true,
                get() { throw new Error("deep toJSON getter must not run") },
            })
            return child
        },
        child => {
            child.steps[0].latencyMs = new Proxy(child.steps[0].latencyMs, {
                get() { throw new Error("nested proxy getter must not run") },
                ownKeys() { throw new Error("nested proxy ownKeys must not run") },
            })
            return child
        },
        child => {
            child.steps[0].cycle = child.steps[0]
            return child
        },
    ]
    for (const childName of ["nonMulti", "multi"]) {
        for (const mutate of mutations) {
            const hostile = mutate(childName === "nonMulti" ? nonMultiReport() : multiReport())
            let stdout = ""
            const code = await acceptance.runCli({
                argv: ["--formal", "--rounds", "1"],
                runAcceptance: () => acceptance.runFullServerAcceptance({
                    formal: true,
                    rounds: 1,
                    runNonMulti: async () => childName === "nonMulti" ? hostile : nonMultiReport(),
                    runMulti: async () => childName === "multi" ? hostile : multiReport(),
                    readReference: async () => null,
                }),
                writeStdout: value => { stdout += value },
            })
            const report = JSON.parse(stdout)
            assert.equal(stdout, `${JSON.stringify(report, null, 2)}\n`)
            assert.equal(code, 1)
            assert.deepEqual(report.rounds[0][childName], {
                invalid: true,
                error: {
                    name: "Error",
                    message: `invalid ${childName === "nonMulti" ? "non-multi" : "multi"} child report`,
                },
            })
            assert.equal(report.gate.admitted, false)
        }
    }
})

test("valid child reports are retained as detached plain snapshots", async () => {
    const nonMulti = nonMultiReport()
    const multi = multiReport()
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 1,
        runNonMulti: async () => nonMulti,
        runMulti: async () => multi,
        readReference: async () => null,
    })

    assert.deepEqual(report.rounds[0].nonMulti, nonMulti)
    assert.deepEqual(report.rounds[0].multi, multi)
    assert.notEqual(report.rounds[0].nonMulti, nonMulti)
    assert.notEqual(report.rounds[0].nonMulti.steps, nonMulti.steps)
    assert.notEqual(report.rounds[0].multi, multi)
    assert.notEqual(report.rounds[0].multi.steps, multi.steps)
})

test("runner and cleanup errors remain visible while later child work continues", async () => {
    const cleanup = new Error("database close failed")
    const primary = new Error("non-multi run failed", { cause: cleanup })
    let multiRan = false
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 1,
        runNonMulti: async () => { throw primary },
        runMulti: async () => {
            multiRan = true
            return multiReport()
        },
        readReference: async () => null,
    })
    assert.equal(multiRan, true)
    assert.deepEqual(report.rounds[0].nonMulti, {
        invalid: true,
        error: { name: "Error", message: "invalid non-multi child report" },
    })
    assert.equal(report.rounds[0].errors[0].child, "nonMulti")
    assert.equal(report.rounds[0].errors[0].error.message, "non-multi run failed")
    assert.equal(report.rounds[0].errors[0].error.cause.message, "database close failed")
    assert.equal(report.gate.structuralAdmitted, false)
})

test("throwing proxy errors serialize generically and do not stop the next child", async () => {
    const hostile = new Proxy({}, {
        get() { throw new Error("proxy getter must not run") },
        getOwnPropertyDescriptor() { throw new Error("proxy descriptor must not run") },
        getPrototypeOf() { throw new Error("proxy prototype must not run") },
    })
    let multiRan = false
    const report = await acceptance.runFullServerAcceptance({
        formal: true,
        rounds: 1,
        runNonMulti: async () => { throw hostile },
        runMulti: async () => {
            multiRan = true
            return multiReport()
        },
        readReference: async () => null,
    })

    assert.equal(multiRan, true)
    assert.deepEqual(report.rounds[0].errors[0].error, {
        name: "Error",
        message: "operation failed",
    })
})

test("CLI replaces BigInt and proxy children with safe parseable placeholders", async () => {
    const hostileChildren = [
        { gate: { admitted: true }, unknownSecret: 123n },
        new Proxy({ unknownSecret: "must-not-leak" }, {
            get() { throw new Error("proxy getter must not run") },
            ownKeys() { throw new Error("proxy ownKeys must not run") },
        }),
    ]
    for (const hostile of hostileChildren) {
        let stdout = ""
        const code = await acceptance.runCli({
            argv: [],
            runAcceptance: () => acceptance.runFullServerAcceptance({
                formal: false,
                rounds: 1,
                runNonMulti: async () => hostile,
                runMulti: async () => multiReport({ formal: false }),
                readReference: async () => null,
            }),
            writeStdout: value => { stdout += value },
        })
        const report = JSON.parse(stdout)
        assert.equal(stdout, `${JSON.stringify(report, null, 2)}\n`)
        assert.equal(code, 1)
        assert.deepEqual(report.rounds[0].nonMulti, {
            invalid: true,
            error: { name: "Error", message: "invalid non-multi child report" },
        })
        assert.equal(report.rounds[0].multi.gate.admitted, true)
        assert.doesNotMatch(stdout, /must-not-leak|unknownSecret/)
    }
})

test("median is deterministic and latency extraction uses real step schemas", () => {
    assert.equal(acceptance.median([9, 1, 5]), 5)
    assert.equal(acceptance.median([9, 1, 5, 3]), 4)
    assert.equal(acceptance.extractP95(nonMultiReport({ p95: 40 }), "nonMulti"), 40)
    assert.equal(acceptance.extractP95(multiReport({ p95: 25 }), "multi"), 25)
    assert.equal(acceptance.extractP95({ steps: [{ latency: { p95: 99 } }] }, "multi"), null)
})

test("median remains finite at Number.MAX_VALUE", () => {
    assert.equal(acceptance.median([Number.MAX_VALUE, Number.MAX_VALUE]), Number.MAX_VALUE)
    assert.ok(Number.isFinite(acceptance.median([Number.MAX_VALUE / 2, Number.MAX_VALUE])))
})

test("huge finite ratios stay finite while overflow ratios reject explicitly", async () => {
    const baseline = (await formalRun()).report
    const hugeReference = acceptance.createReference(baseline)
    hugeReference.mediansMs.nonMultiP95 = 1
    const huge = (await formalRun({
        nonMultiP95: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
        readReference: async () => hugeReference,
    })).report
    assert.equal(Number.isFinite(huge.latency.observedRatios.nonMulti), true)
    assert.equal(huge.gate.latencyAdmitted, false)

    const overflowReference = acceptance.createReference(baseline)
    overflowReference.mediansMs.nonMultiP95 = Number.MIN_VALUE
    const overflow = (await formalRun({ readReference: async () => overflowReference })).report
    const reparsed = JSON.parse(JSON.stringify(overflow))
    assert.equal(reparsed.latency.observedRatios.nonMulti, null)
    assert.equal(reparsed.gate.referenceComparable, true)
    assert.equal(reparsed.gate.latencyAdmitted, false)
    assert.equal(reparsed.gate.admitted, false)
})

test("same-machine 20 percent regression is admitted at the boundary", async () => {
    const baseline = (await formalRun()).report
    const reference = acceptance.createReference(baseline)
    const { report } = await formalRun({
        nonMultiP95: [120, 120, 120],
        multiP95: [60, 60, 60],
        readReference: async () => reference,
    })
    assert.equal(report.gate.referenceComparable, true)
    assert.deepEqual(report.latency.observedRatios, { nonMulti: 1.2, multi: 1.2 })
    assert.equal(report.gate.latencyAdmitted, true)
    assert.equal(report.gate.admitted, true)
})

test("same-machine regression above 20 percent is rejected", async () => {
    const baseline = (await formalRun()).report
    const reference = acceptance.createReference(baseline)
    const { report } = await formalRun({
        nonMultiP95: [120.00001, 120.00001, 120.00001],
        multiP95: [50, 50, 50],
        readReference: async () => reference,
    })
    assert.equal(report.gate.referenceComparable, true)
    assert.equal(report.latency.observedRatios.nonMulti, 1.2)
    assert.equal(report.gate.latencyAdmitted, false)
    assert.equal(report.gate.admitted, false)
})

test("machine or profile mismatch keeps ratios informational", async () => {
    const baseline = (await formalRun()).report
    const differentMachine = acceptance.createReference(baseline)
    differentMachine.fingerprint.platform = `${differentMachine.fingerprint.platform}-other`
    const machineResult = (await formalRun({
        nonMultiP95: [200, 200, 200],
        readReference: async () => differentMachine,
    })).report
    assert.equal(machineResult.gate.referenceComparable, false)
    assert.equal(machineResult.latency.observedRatios.nonMulti, 2)
    assert.equal(machineResult.gate.admitted, true)

    const differentProfile = acceptance.createReference(baseline)
    differentProfile.profiles.multi.name = "different-formal-profile"
    const profileResult = (await formalRun({
        multiP95: [100, 100, 100],
        readReference: async () => differentProfile,
    })).report
    assert.equal(profileResult.gate.referenceComparable, false)
    assert.equal(profileResult.latency.observedRatios.multi, 2)
    assert.equal(profileResult.gate.admitted, true)
})

test("reference comparability has one authoritative home in the full gate", async () => {
    const baseline = (await formalRun()).report
    const reference = acceptance.createReference(baseline)
    const report = (await formalRun({ readReference: async () => reference })).report

    assert.deepEqual(Object.keys(report.gate).sort(), [
        "admitted",
        "failures",
        "latencyAdmitted",
        "referenceComparable",
        "structuralAdmitted",
    ])
    assert.equal(report.gate.referenceComparable, true)
    assert.equal(Object.hasOwn(report.latency, "referenceComparable"), false)
})

test("createReference requires exactly three admitted formal rounds", async () => {
    const formal = (await formalRun()).report
    const reference = acceptance.createReference(formal)
    assert.deepEqual(Object.keys(reference).sort(), ["fingerprint", "mediansMs", "profiles"])
    assert.deepEqual(reference.mediansMs, { nonMultiP95: 100, multiP95: 50 })
    assert.doesNotMatch(JSON.stringify(reference).toLowerCase(), /identity|room|token|port|path|error/)
    assert.throws(() => acceptance.createReference({ ...formal, formal: false }), /formal/)
    assert.throws(() => acceptance.createReference({ ...formal, rounds: formal.rounds.slice(0, 2) }), /three|3/)
    const forgedSummary = structuredClone(formal)
    forgedSummary.gate.structuralAdmitted = false
    forgedSummary.gate.admitted = false
    forgedSummary.rounds[1].structural.admitted = false
    assert.deepEqual(acceptance.createReference(forgedSummary), reference)
})

test("createReference revalidates child reports instead of trusting forged summary gates", async () => {
    const baseline = (await formalRun()).report
    const rejected = nonMultiReport()
    rejected.steps[0].errors = 1
    rejected.steps[0].entries[0].errors = 1
    rejected.gate = createAdmissionGate({
        metadata: rejected.metadata,
        profile: rejected.profile,
        steps: rejected.steps,
    })
    const mutations = [
        report => { report.rounds[0].nonMulti = null },
        report => { report.rounds[0].multi = { gate: { admitted: true } } },
        report => { report.rounds[1].nonMulti = rejected },
        report => { report.rounds[2].multi.steps[0].cleanup.activeProcesses = 1 },
        report => { report.rounds[0].errors.push({ child: "multi", error: { message: "cleanup" } }) },
    ]
    for (const mutate of mutations) {
        const forged = structuredClone(baseline)
        mutate(forged)
        forged.gate = { ...baseline.gate, structuralAdmitted: true, admitted: true }
        for (const round of forged.rounds) round.structural.admitted = true
        assert.throws(() => acceptance.createReference(forged), /child|structural/)
    }
})

test("createReference recomputes medians from the three validated child rounds", async () => {
    const report = (await formalRun({
        nonMultiP95: [100, 300, 200],
        multiP95: [30, 10, 20],
    })).report
    report.latency.observedMediansMs = { nonMultiP95: 999, multiP95: 999 }

    assert.deepEqual(acceptance.createReference(report).mediansMs, {
        nonMultiP95: 200,
        multiP95: 20,
    })
})

test("createReference binds a forged 2x-latency report to the current machine fingerprint", async () => {
    const report = (await formalRun({
        nonMultiP95: [200, 200, 200],
        multiP95: [100, 100, 100],
    })).report
    const currentFingerprint = { ...report.fingerprint }
    report.fingerprint.platform = `${report.fingerprint.platform}-forged`

    assert.throws(
        () => acceptance.createReference(report, { currentFingerprint }),
        /current.*fingerprint|fingerprint.*current/i,
    )
})

test("sparse formal rounds cannot create or write a reference", async () => {
    const report = (await formalRun()).report
    delete report.rounds[2]
    assert.throws(() => acceptance.createReference(report), /dense|three|3/i)

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-sparse-rounds-"))
    const referencePath = path.join(directory, "reference.json")
    try {
        await assert.rejects(
            acceptance.runCli({
                argv: ["--formal", "--write-reference", referencePath],
                runAcceptance: async () => report,
                writeStdout: () => assert.fail("sparse report must not reach stdout"),
            }),
            /dense|three|3/i,
        )
        assert.equal(fs.existsSync(referencePath), false)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("reference precondition failure performs zero output writes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-precondition-"))
    const outputPath = path.join(directory, "full.json")
    const referencePath = path.join(directory, "reference.json")
    fs.writeFileSync(outputPath, "original-output", "utf8")
    const report = (await formalRun()).report
    report.rounds[0].nonMulti = null
    try {
        await assert.rejects(acceptance.runCli({
            argv: ["--formal", "--output", outputPath, "--write-reference", referencePath],
            runAcceptance: async () => report,
            writeStdout: () => {},
        }), /child|reference/i)
        assert.equal(fs.readFileSync(outputPath, "utf8"), "original-output")
        assert.equal(fs.existsSync(referencePath), false)
        assert.deepEqual(fs.readdirSync(directory), ["full.json"])
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("runCli writes full output and a safe reference while emitting one JSON", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-server-acceptance-test-"))
    const outputPath = path.join(directory, "full.json")
    const referencePath = path.join(directory, "reference.json")
    let stdout = ""
    try {
        const code = await acceptance.runCli({
            argv: ["--formal", "--output", outputPath, "--write-reference", referencePath],
            runAcceptance: async options => {
                assert.equal(options.formal, true)
                assert.equal(options.rounds, 3)
                return (await formalRun()).report
            },
            writeStdout: value => { stdout += value },
        })
        assert.equal(code, 0)
        const stdoutReport = JSON.parse(stdout)
        assert.equal(stdout, `${JSON.stringify(stdoutReport, null, 2)}\n`)
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), stdoutReport)
        const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"))
        assert.deepEqual(reference, acceptance.createReference(stdoutReport))
        assert.doesNotMatch(JSON.stringify(reference).toLowerCase(), /identity|room|token|port|path|error/)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
