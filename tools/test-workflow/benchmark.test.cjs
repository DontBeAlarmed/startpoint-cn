const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { PassThrough } = require("node:stream")
const test = require("node:test")

const {
    DEFAULT_COMMANDS,
    buildCommandReport,
    evaluateThreshold,
    forceKillProcessTree,
    installSignalHandlers,
    main,
    median,
    parseRunnerSummary,
    runCommand,
    signalProcessTree,
    writeReport,
} = require("./benchmark.cjs")

function createRun(durationMs, overrides = {}) {
    return {
        durationMs,
        failed: 0,
        output: "",
        passed: 1,
        rawExitCode: 0,
        signal: null,
        skipped: 0,
        spawnError: null,
        timedOut: false,
        ...overrides,
    }
}

function createFakeChild(pid = 321) {
    const child = new EventEmitter()
    child.pid = pid
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    return child
}

function createFakeClock() {
    let nextId = 1
    const timers = new Map()
    return {
        clearTimeout(timerId) {
            timers.delete(timerId)
        },
        fire(delayMs) {
            const entry = [...timers.entries()].find(([, timer]) => timer.delayMs === delayMs)
            assert.ok(entry, `missing ${delayMs}ms timer`)
            timers.delete(entry[0])
            entry[1].callback()
        },
        pendingCount() {
            return timers.size
        },
        setTimeout(callback, delayMs) {
            const timerId = nextId++
            timers.set(timerId, { callback, delayMs })
            return timerId
        },
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error.code === "ESRCH") return false
        throw error
    }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    return !isProcessAlive(pid)
}

test("runs the changed benchmark directly with an explicit source file", () => {
    const command = DEFAULT_COMMANDS.find(candidate => candidate.name === "test:changed")

    assert.equal(command.executable, process.execPath)
    assert.deepEqual(command.args, [
        "tools/test-workflow/run.cjs",
        "--files",
        "src/lib/gacha.ts",
    ])
    assert.equal(
        command.command,
        "node tools/test-workflow/run.cjs --files src/lib/gacha.ts",
    )
})

test("calculates odd and even medians without changing the samples", () => {
    const oddSamples = [9, 1, 5]
    const evenSamples = [9, 1, 5, 3]

    assert.equal(median(oddSamples), 5)
    assert.equal(median(evenSamples), 4)
    assert.deepEqual(oddSamples, [9, 1, 5])
    assert.deepEqual(evenSamples, [9, 1, 5, 3])
})

test("fails threshold evaluation when the median exceeds the limit", () => {
    assert.deepEqual(evaluateThreshold({
        commandExitCodes: [0, 0, 0],
        medianMs: 5001,
        reportOnly: false,
        thresholdMs: 5000,
    }), {
        commandSucceeded: true,
        exitCode: 1,
        withinThreshold: false,
    })
})

test("keeps command failures non-zero even in report-only mode", () => {
    assert.deepEqual(evaluateThreshold({
        commandExitCodes: [0, 7, 0],
        medianMs: 100,
        reportOnly: true,
        thresholdMs: 5000,
    }), {
        commandSucceeded: false,
        exitCode: 1,
        withinThreshold: true,
    })
})

test("allows an exceeded threshold in report-only mode", () => {
    assert.equal(evaluateThreshold({
        commandExitCodes: [0, 0, 0],
        medianMs: 5001,
        reportOnly: true,
        thresholdMs: 5000,
    }).exitCode, 0)
})

test("compares the unrounded median against the threshold", () => {
    const command = {
        command: "fixture",
        name: "fixture",
        thresholdMs: 5000,
    }
    const report = buildCommandReport(
        command,
        createRun(1),
        [createRun(5000.0004), createRun(5000.0004), createRun(5000.0004)],
        { reportOnly: false },
    )

    assert.equal(report.medianMs, 5000)
    assert.equal(report.withinThreshold, false)
    assert.equal(report.exitCode, 1)
})

test("waits for the fixed process-group force kill after a timed-out child closes", async () => {
    const child = createFakeChild()
    const clock = createFakeClock()
    const signals = []
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [],
        command: "fixture",
        executable: "fixture",
        timeoutMs: 10,
    }, state, {
        clearTimeout: clock.clearTimeout,
        forceKillAfterMs: 20,
        killProcess(target, signal) { signals.push([target, signal]) },
        now: () => 0,
        platform: "linux",
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })
    let settled = false
    resultPromise.then(() => { settled = true })

    child.pid = 999
    clock.fire(10)
    child.emit("close", 0, null)
    await Promise.resolve()

    assert.equal(settled, false)
    assert.equal(state.activeRun.processGroupId, 321)
    clock.fire(20)
    const result = await resultPromise

    assert.deepEqual(signals, [[-321, "SIGTERM"], [-321, "SIGKILL"]])
    assert.equal(result.timedOut, true)
    assert.equal(state.activeRun, null)
    assert.equal(clock.pendingCount(), 0)
})

test("waits for force kill after an interrupted child closes", async () => {
    const child = createFakeChild(432)
    const clock = createFakeClock()
    const processTarget = new EventEmitter()
    const signals = []
    const state = { activeRun: null, interruptedBy: null }
    const options = {
        clearTimeout: clock.clearTimeout,
        forceKillAfterMs: 20,
        killProcess(target, signal) { signals.push([target, signal]) },
        now: () => 0,
        platform: "linux",
        processTarget,
        setTimeout: clock.setTimeout,
        spawn: () => child,
    }
    const resultPromise = runCommand({
        args: [],
        command: "fixture",
        executable: "fixture",
        timeoutMs: 100,
    }, state, options)
    const removeHandlers = installSignalHandlers(state, options)
    let settled = false
    resultPromise.then(() => { settled = true })

    processTarget.emit("SIGINT")
    child.emit("close", 0, null)
    await Promise.resolve()

    assert.equal(settled, false)
    clock.fire(20)
    await resultPromise
    await removeHandlers()

    assert.deepEqual(signals, [[-432, "SIGINT"], [-432, "SIGKILL"]])
    assert.equal(clock.pendingCount(), 0)
})

test("treats ESRCH as clean and records other process-tree cleanup errors", async () => {
    const child = createFakeChild(654)
    const clock = createFakeClock()
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [],
        command: "fixture",
        executable: "fixture",
        timeoutMs: 10,
    }, state, {
        clearTimeout: clock.clearTimeout,
        forceKillAfterMs: 20,
        killProcess(target, signal) {
            assert.equal(target, -654)
            const error = new Error(signal === "SIGTERM" ? "already gone" : "permission denied")
            error.code = signal === "SIGTERM" ? "ESRCH" : "EACCES"
            throw error
        },
        now: () => 0,
        platform: "linux",
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })

    assert.doesNotThrow(() => clock.fire(10))
    child.emit("close", 0, null)
    assert.doesNotThrow(() => clock.fire(20))
    const result = await resultPromise

    assert.doesNotMatch(result.output, /already gone/)
    assert.match(result.output, /failed to force-kill process tree: permission denied/)
})

test("signal handlers retain the active run captured at signal time", async () => {
    const processTarget = new EventEmitter()
    const capturedRun = { child: createFakeChild(41), processGroupId: 41 }
    const replacementRun = { child: createFakeChild(99), processGroupId: 99 }
    const state = { activeRun: capturedRun, interruptedBy: null }
    const calls = []
    const removeHandlers = installSignalHandlers(state, {
        processTarget,
        scheduleForceKill(run) {
            calls.push(["force", run.processGroupId])
            return Promise.resolve()
        },
        signalProcessTree(run, signal) {
            calls.push([signal, run.processGroupId])
            state.activeRun = replacementRun
        },
    })

    processTarget.emit("SIGTERM")
    await removeHandlers()

    assert.equal(state.interruptedBy, "SIGTERM")
    assert.deepEqual(calls, [["SIGTERM", 41], ["force", 41]])
})

test("uses child.kill then taskkill for Windows process trees", () => {
    const signals = []
    const taskkillCalls = []
    const activeRun = {
        child: { kill(signal) { signals.push(signal) } },
        processGroupId: 77,
    }

    signalProcessTree(activeRun, "SIGTERM", { platform: "win32" })
    forceKillProcessTree(activeRun, {
        platform: "win32",
        spawnSync(command, args, options) {
            taskkillCalls.push({ args, command, options })
            return { status: 0, stderr: "" }
        },
    })

    assert.deepEqual(signals, ["SIGTERM"])
    assert.deepEqual(taskkillCalls, [{
        args: ["/PID", "77", "/T", "/F"],
        command: "taskkill",
        options: { encoding: "utf8", windowsHide: true },
    }])
})

test("timeout kills a TERM-resistant grandchild after its parent closes", {
    skip: process.platform === "win32",
}, async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-tree-"))
    const fixturePath = path.join(fixtureRoot, "parent.cjs")
    const pidPath = path.join(fixtureRoot, "grandchild.pid")
    let grandchildPid = null
    t.after(() => {
        if (grandchildPid !== null && isProcessAlive(grandchildPid)) {
            try { process.kill(grandchildPid, "SIGKILL") } catch {}
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true })
    })
    fs.writeFileSync(fixturePath, [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })',
        'fs.writeFileSync(process.argv[2], String(child.pid))',
        'process.on("SIGTERM", () => process.exit(0))',
        'setInterval(() => {}, 1000)',
    ].join("\n"))

    const state = { activeRun: null, interruptedBy: null }
    const result = await runCommand({
        args: [fixturePath, pidPath],
        command: "fixture",
        executable: process.execPath,
        timeoutMs: 200,
    }, state, { cwd: fixtureRoot, forceKillAfterMs: 100 })
    grandchildPid = Number(fs.readFileSync(pidPath, "utf8"))

    assert.equal(result.timedOut, true)
    assert.equal(await waitForProcessExit(grandchildPid), true)
})

test("keeps an existing report intact when atomic writing fails", t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-report-fail-"))
    const reportPath = path.join(fixtureRoot, "report.json")
    const original = '{"status":"existing"}\n'
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))
    fs.writeFileSync(reportPath, original)
    const fsWithFailedWrite = {
        ...fs,
        writeFileSync(filePath, contents, options) {
            assert.notEqual(filePath, reportPath)
            fs.writeFileSync(filePath, contents.slice(0, 8), options)
            throw new Error("injected write failure")
        },
    }

    assert.throws(() => writeReport(
        { schemaVersion: 1 },
        reportPath,
        fixtureRoot,
        {
            fs: fsWithFailedWrite,
            randomUUID: () => "failed-write",
            writeOutput() {},
        },
    ), /injected write failure/)
    assert.equal(fs.readFileSync(reportPath, "utf8"), original)
    assert.deepEqual(fs.readdirSync(fixtureRoot), ["report.json"])
})

test("atomically replaces an existing report with valid JSON", t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-report-ok-"))
    const reportPath = path.join(fixtureRoot, "report.json")
    const report = { commands: [], schemaVersion: 1 }
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))
    fs.writeFileSync(reportPath, "old report")

    writeReport(report, reportPath, fixtureRoot, {
        randomUUID: () => "successful-write",
        writeOutput() {},
    })

    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), report)
    assert.deepEqual(fs.readdirSync(fixtureRoot), ["report.json"])
})

test("reports spawn failures and clears the normal timeout timer", async () => {
    const child = createFakeChild(null)
    const clock = createFakeClock()
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [],
        command: "missing",
        executable: "missing",
        timeoutMs: 100,
    }, state, {
        clearTimeout: clock.clearTimeout,
        now: () => 0,
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })
    const error = Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" })

    child.emit("error", error)
    child.emit("close", null, null)
    const result = await resultPromise

    assert.equal(result.spawnError, "spawn missing ENOENT")
    assert.equal(result.rawExitCode, null)
    assert.equal(result.timedOut, false)
    assert.equal(state.activeRun, null)
    assert.equal(clock.pendingCount(), 0)
})

test("main stays non-zero for command failures in report-only mode", async () => {
    let writtenReport = null
    const exitCode = await main(["--report-only", "--only", "fixture"], {
        benchmarkCommand: async () => ({ exitCode: 1, name: "fixture" }),
        commands: [{ name: "fixture" }],
        createDate: () => new Date("2026-07-20T00:00:00.000Z"),
        installSignalHandlers: () => async () => {},
        readCommit: () => "fixture-commit",
        writeError() {},
        writeReport(report) { writtenReport = report },
    })

    assert.equal(exitCode, 1)
    assert.deepEqual(writtenReport.commands, [{ exitCode: 1, name: "fixture" }])
})

test("main writes a valid report to the requested output path", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-main-output-"))
    const relativeOutputPath = path.join("reports", "workflow.json")
    const outputPath = path.join(fixtureRoot, relativeOutputPath)
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))

    const exitCode = await main(["--only", "fixture", "--output", relativeOutputPath], {
        benchmarkCommand: async () => ({ exitCode: 0, name: "fixture" }),
        commands: [{ name: "fixture" }],
        createDate: () => new Date("2026-07-20T00:00:00.000Z"),
        cwd: fixtureRoot,
        installSignalHandlers: () => async () => {},
        readCommit: () => "fixture-commit",
        writeError() {},
        writeOutput() {},
    })
    const report = JSON.parse(fs.readFileSync(outputPath, "utf8"))

    assert.equal(exitCode, 0)
    assert.equal(report.commit, "fixture-commit")
    assert.equal(report.startedAt, "2026-07-20T00:00:00.000Z")
    assert.deepEqual(report.commands, [{ exitCode: 0, name: "fixture" }])
})

test("parses passed, failed, and skipped counts from the last runner summary", () => {
    const output = [
        "Summary: passed=1 failed=2 skipped=3 total=40ms",
        "npm notice unrelated output",
        "Summary: passed=14 failed=0 skipped=1 total=1.24s",
    ].join("\n")

    assert.deepEqual(parseRunnerSummary(output), {
        failed: 0,
        passed: 14,
        skipped: 1,
    })
    assert.equal(parseRunnerSummary("TypeScript completed without output"), null)
})
