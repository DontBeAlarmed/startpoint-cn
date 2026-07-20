const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { PassThrough } = require("node:stream")
const test = require("node:test")

const {
    DEFAULT_COMMANDS,
    MAX_OUTPUT_BYTES,
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
        outputTruncated: false,
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

function createSingleProcessTable(pid) {
    return [
        { pgid: 999999, pid: process.pid, ppid: 1 },
        { pgid: pid, pid, ppid: process.pid },
    ]
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

async function waitForFile(filePath, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`fixture did not become ready within ${timeoutMs}ms`)
}

test("runs every default benchmark command directly with Node", () => {
    assert.deepEqual(DEFAULT_COMMANDS.map(command => ({
        args: command.args,
        command: command.command,
        executable: command.executable,
        name: command.name,
    })), [
        {
            args: ["tools/test-workflow/run.cjs", "--group", "quick"],
            command: "node tools/test-workflow/run.cjs --group quick",
            executable: process.execPath,
            name: "test:quick",
        },
        {
            args: ["tools/test-workflow/run.cjs", "--files", "src/lib/gacha.ts"],
            command: "node tools/test-workflow/run.cjs --files src/lib/gacha.ts",
            executable: process.execPath,
            name: "test:changed",
        },
        {
            args: ["tools/test-workflow/run.cjs", "--group", "integration"],
            command: "node tools/test-workflow/run.cjs --group integration",
            executable: process.execPath,
            name: "test:integration",
        },
        {
            args: ["tools/test-workflow/run.cjs", "--group", "full"],
            command: "node tools/test-workflow/run.cjs --group full",
            executable: process.execPath,
            name: "test:full",
        },
        {
            args: [
                "--max-old-space-size=4096",
                "node_modules/typescript/bin/tsc",
                "--noEmit",
            ],
            command: "node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit",
            executable: process.execPath,
            name: "typecheck",
        },
    ])
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
        readProcessTable: () => createSingleProcessTable(321),
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
        readProcessTable: () => createSingleProcessTable(432),
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

    assert.deepEqual(signals, [[-432, "SIGTERM"], [-432, "SIGKILL"]])
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
        readProcessTable: () => createSingleProcessTable(654),
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })

    assert.doesNotThrow(() => clock.fire(10))
    child.emit("close", 0, null)
    assert.doesNotThrow(() => clock.fire(20))
    const result = await resultPromise

    assert.doesNotMatch(result.output, /already gone/)
    assert.match(result.output, /failed to signal group 654 with SIGKILL: permission denied/)
})

test("signals captured POSIX descendant groups leaf-first without killing its own group", () => {
    const signals = []
    let processTableReads = 0
    const activeRun = {
        child: createFakeChild(100),
        cleanupErrors: [],
        processGroupId: 100,
    }
    const options = {
        currentPid: 10,
        killProcess(target, signal) { signals.push([target, signal]) },
        platform: "linux",
        readProcessTable() {
            processTableReads++
            return [
                { pgid: 10, pid: 10, ppid: 1 },
                { pgid: 100, pid: 100, ppid: 10 },
                { pgid: 200, pid: 200, ppid: 100 },
                { pgid: 200, pid: 201, ppid: 200 },
                { pgid: 10, pid: 300, ppid: 100 },
            ]
        },
    }

    signalProcessTree(activeRun, "SIGTERM", options)
    forceKillProcessTree(activeRun, options)

    assert.equal(processTableReads, 1)
    assert.deepEqual(signals, [
        [-200, "SIGTERM"],
        [300, "SIGTERM"],
        [-100, "SIGTERM"],
        [-200, "SIGKILL"],
        [300, "SIGKILL"],
        [-100, "SIGKILL"],
    ])
    assert.equal(signals.some(([target]) => target === -10), false)
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

test("uses non-forced then forced taskkill for Windows process trees", () => {
    const taskkillCalls = []
    const activeRun = {
        child: { kill() { assert.fail("Windows tree cleanup must not call child.kill") } },
        processGroupId: 77,
    }
    const options = {
        platform: "win32",
        spawnSync(command, args, spawnOptions) {
            taskkillCalls.push({ args, command, options: spawnOptions })
            return { status: 0, stderr: "" }
        },
    }

    signalProcessTree(activeRun, "SIGTERM", options)
    forceKillProcessTree(activeRun, options)

    assert.deepEqual(taskkillCalls, [
        {
            args: ["/PID", "77", "/T"],
            command: "taskkill",
            options: { encoding: "utf8", windowsHide: true },
        },
        {
            args: ["/PID", "77", "/T", "/F"],
            command: "taskkill",
            options: { encoding: "utf8", windowsHide: true },
        },
    ])
})

test("timeout kills a detached test process group and its descendant after ready", {
    skip: process.platform === "win32",
}, async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-nested-tree-"))
    const runnerPath = path.join(fixtureRoot, "runner.cjs")
    const testPath = path.join(fixtureRoot, "test-process.cjs")
    const descendantPath = path.join(fixtureRoot, "descendant.cjs")
    const readyPath = path.join(fixtureRoot, "ready")
    const pidPath = path.join(fixtureRoot, "pids.json")
    const fixturePids = []
    t.after(() => {
        for (const pid of fixturePids) {
            if (isProcessAlive(pid)) {
                try { process.kill(pid, "SIGKILL") } catch {}
            }
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true })
    })
    fs.writeFileSync(runnerPath, [
        'const { spawn } = require("node:child_process")',
        'spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: "ignore" })',
        'process.on("SIGTERM", () => process.exit(0))',
        'setInterval(() => {}, 1000)',
    ].join("\n"))
    fs.writeFileSync(testPath, [
        'const { spawn } = require("node:child_process")',
        'process.on("SIGTERM", () => {})',
        'spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4], String(process.pid)], { stdio: "ignore" })',
        'setInterval(() => {}, 1000)',
    ].join("\n"))
    fs.writeFileSync(descendantPath, [
        'const fs = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        'fs.writeFileSync(process.argv[2], JSON.stringify({ test: Number(process.argv[4]), descendant: process.pid }))',
        'fs.writeFileSync(process.argv[3], "ready")',
        'setInterval(() => {}, 1000)',
    ].join("\n"))

    const clock = createFakeClock()
    let nestedPids = null
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [runnerPath, testPath, descendantPath, pidPath, readyPath],
        command: "fixture",
        executable: process.execPath,
        timeoutMs: 5000,
    }, state, {
        clearTimeout: clock.clearTimeout,
        currentProcessGroupId: 999999,
        cwd: fixtureRoot,
        forceKillAfterMs: 100,
        readProcessTable() {
            assert.notEqual(nestedPids, null)
            return [
                { pgid: 999999, pid: process.pid, ppid: 1 },
                { pgid: runnerPid, pid: runnerPid, ppid: process.pid },
                { pgid: nestedPids.test, pid: nestedPids.test, ppid: runnerPid },
                {
                    pgid: nestedPids.test,
                    pid: nestedPids.descendant,
                    ppid: nestedPids.test,
                },
            ]
        },
        setTimeout: clock.setTimeout,
    })
    const runnerPid = state.activeRun.processGroupId
    fixturePids.push(runnerPid)
    await waitForFile(readyPath)
    nestedPids = JSON.parse(fs.readFileSync(pidPath, "utf8"))
    fixturePids.push(nestedPids.test, nestedPids.descendant)

    clock.fire(5000)
    clock.fire(100)
    const result = await resultPromise

    assert.equal(result.timedOut, true)
    for (const pid of fixturePids) {
        assert.equal(await waitForProcessExit(pid), true, `process ${pid} survived timeout`)
    }
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

test("caps captured output while preserving the final summary and error tail", async () => {
    const child = createFakeChild()
    const clock = createFakeClock()
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [],
        command: "verbose",
        executable: "verbose",
        timeoutMs: 100,
    }, state, {
        clearTimeout: clock.clearTimeout,
        now: () => 0,
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })
    const summary = "\nSummary: passed=9 failed=1 skipped=2 total=3.00s\n"
    const errorTail = "final diagnostic tail\n"

    for (let index = 0; index < 1100; index++) {
        child.stdout.write(Buffer.alloc(1024, "x"))
    }
    child.stdout.write(summary)
    child.stderr.write(errorTail)
    child.emit("close", 1, null)
    const result = await resultPromise
    const report = buildCommandReport(
        { command: "verbose", name: "verbose", thresholdMs: 1000 },
        createRun(1),
        [result, createRun(1), createRun(1)],
    )

    assert.ok(Buffer.byteLength(result.output) <= MAX_OUTPUT_BYTES)
    assert.match(result.output, /Summary: passed=9 failed=1 skipped=2/)
    assert.match(result.output, /final diagnostic tail/)
    assert.equal(result.outputTruncated, true)
    assert.deepEqual(
        { failed: result.failed, passed: result.passed, skipped: result.skipped },
        { failed: 1, passed: 9, skipped: 2 },
    )
    assert.equal(report.outputTruncated, true)
    assert.equal(report.runs[0].outputTruncated, true)
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
