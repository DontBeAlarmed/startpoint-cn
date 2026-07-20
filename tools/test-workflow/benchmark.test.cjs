const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
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
    createTailBuffer,
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
        { identity: `process-${process.pid}`, pgid: 999999, pid: process.pid, ppid: 1 },
        { identity: `process-${pid}`, pgid: pid, pid, ppid: process.pid },
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

    assert.deepEqual(signals, [[-321, "SIGTERM"], [321, "SIGKILL"]])
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

    assert.deepEqual(signals, [[-432, "SIGTERM"], [432, "SIGKILL"]])
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
            assert.equal(target, signal === "SIGTERM" ? -654 : 654)
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
    assert.match(result.output, /failed to force-kill pid 654: permission denied/)
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
                { identity: "benchmark", pgid: 10, pid: 10, ppid: 1 },
                { identity: "root", pgid: 100, pid: 100, ppid: 10 },
                { identity: "child", pgid: 200, pid: 200, ppid: 100 },
                { identity: "descendant", pgid: 200, pid: 201, ppid: 200 },
                { identity: "shared-group", pgid: 10, pid: 300, ppid: 100 },
            ]
        },
    }

    signalProcessTree(activeRun, "SIGTERM", options)
    forceKillProcessTree(activeRun, options)

    assert.equal(processTableReads, 2)
    assert.deepEqual(signals, [
        [-200, "SIGTERM"],
        [300, "SIGTERM"],
        [-100, "SIGTERM"],
        [201, "SIGKILL"],
        [200, "SIGKILL"],
        [300, "SIGKILL"],
        [100, "SIGKILL"],
    ])
    assert.equal(signals.some(([target]) => target === -10), false)
})

test("force kill skips reused PIDs and kills matching process identities", () => {
    const signals = []
    let readCount = 0
    const activeRun = {
        child: createFakeChild(700),
        cleanupErrors: [],
        processGroupId: 700,
    }
    const options = {
        currentPid: 10,
        killProcess(target, signal) { signals.push([target, signal]) },
        platform: "linux",
        readProcessTable() {
            readCount++
            return [
                { identity: "benchmark", pgid: 10, pid: 10, ppid: 1 },
                {
                    identity: readCount === 1 ? "root-original" : "root-reused",
                    pgid: 700,
                    pid: 700,
                    ppid: 10,
                },
                { identity: "child-stable", pgid: 701, pid: 701, ppid: 700 },
            ]
        },
    }

    signalProcessTree(activeRun, "SIGTERM", options)
    forceKillProcessTree(activeRun, options)

    assert.deepEqual(signals, [
        [-701, "SIGTERM"],
        [-700, "SIGTERM"],
        [701, "SIGKILL"],
    ])
})

test("bounds ps snapshots and records timeout fallback errors", () => {
    const calls = []
    const signals = []
    const activeRun = {
        child: createFakeChild(808),
        cleanupErrors: [],
        processGroupId: 808,
    }
    const timeoutError = Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" })

    signalProcessTree(activeRun, "SIGTERM", {
        currentProcessGroupId: 999999,
        killProcess(target, signal) { signals.push([target, signal]) },
        platform: "linux",
        spawnSync(command, args, options) {
            calls.push({ args, command, options })
            return { error: timeoutError, status: null, stderr: "" }
        },
    })

    assert.deepEqual(calls, [{
        args: ["-axo", "pid=,ppid=,pgid=,lstart="],
        command: "ps",
        options: { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 1000 },
    }])
    assert.deepEqual(signals, [[-808, "SIGTERM"]])
    assert.match(activeRun.cleanupErrors.join("\n"), /failed to read POSIX process tree: ps timed out/)
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

test("Windows timeout completes one forced taskkill before resolving", async () => {
    const child = createFakeChild(77)
    const clock = createFakeClock()
    const taskkillCalls = []
    const state = { activeRun: null, interruptedBy: null }
    let taskkillCompleted = false
    const resultPromise = runCommand({
        args: [],
        command: "windows-fixture",
        executable: "windows-fixture",
        timeoutMs: 10,
    }, state, {
        clearTimeout: clock.clearTimeout,
        now: () => 0,
        platform: "win32",
        spawnSync(command, args, spawnOptions) {
            taskkillCalls.push({ args, command, options: spawnOptions })
            taskkillCompleted = true
            return { status: 0, stderr: "" }
        },
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })
    let resolved = false
    resultPromise.then(() => { resolved = true })

    clock.fire(10)
    assert.equal(taskkillCompleted, true)
    assert.equal(clock.pendingCount(), 0)
    assert.equal(resolved, false)
    child.emit("close", 0, null)
    const result = await resultPromise

    assert.equal(result.timedOut, true)
    assert.deepEqual(taskkillCalls, [{
        args: ["/PID", "77", "/T", "/F"],
        command: "taskkill",
        options: {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
            timeout: 5000,
            windowsHide: true,
        },
    }])
})

test("Windows taskkill timeouts fall back to root kill and resolve without close", async () => {
    const child = createFakeChild(88)
    const clock = createFakeClock()
    const killCalls = []
    child.kill = signal => {
        killCalls.push(signal)
        return true
    }
    const state = { activeRun: null, interruptedBy: null }
    let nowCalls = 0
    const resultPromise = runCommand({
        args: [],
        command: "windows-timeout",
        executable: "windows-timeout",
        timeoutMs: 10,
    }, state, {
        clearTimeout: clock.clearTimeout,
        now: () => nowCalls++,
        platform: "win32",
        spawnSync() {
            return {
                error: Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" }),
                status: null,
                stderr: "",
            }
        },
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })
    let resolutions = 0
    resultPromise.then(() => { resolutions++ })

    clock.fire(10)
    assert.deepEqual(killCalls, ["SIGKILL"])
    assert.equal(clock.pendingCount(), 1)
    clock.fire(1000)
    const result = await resultPromise
    const report = buildCommandReport(
        { command: "windows-timeout", name: "windows-timeout", thresholdMs: 100 },
        createRun(1),
        [result, createRun(1), createRun(1)],
    )

    assert.equal(result.cleanupError, true)
    assert.equal(result.rawExitCode, null)
    assert.equal(result.timedOut, true)
    assert.match(result.output, /failed to signal process tree with SIGTERM: taskkill timed out/)
    assert.equal(report.commandSucceeded, false)
    assert.equal(report.exitCode, 1)
    assert.equal(clock.pendingCount(), 0)

    const completedResult = { ...result }
    const completedNowCalls = nowCalls
    child.emit("close", 0, null)
    await Promise.resolve()
    assert.equal(resolutions, 1)
    assert.equal(nowCalls, completedNowCalls)
    assert.deepEqual(result, completedResult)
})

test("Windows taskkill non-zero status has a bounded fallback without child close", async () => {
    const child = createFakeChild(89)
    const clock = createFakeClock()
    const killCalls = []
    child.kill = signal => {
        killCalls.push(signal)
        return true
    }
    const state = { activeRun: null, interruptedBy: null }
    const resultPromise = runCommand({
        args: [],
        command: "windows-failure",
        executable: "windows-failure",
        timeoutMs: 10,
    }, state, {
        clearTimeout: clock.clearTimeout,
        now: () => 0,
        platform: "win32",
        spawnSync() {
            return { status: 1, stderr: "access denied" }
        },
        setTimeout: clock.setTimeout,
        spawn: () => child,
    })

    clock.fire(10)
    assert.deepEqual(killCalls, ["SIGKILL"])
    clock.fire(1000)
    const result = await resultPromise

    assert.equal(result.cleanupError, true)
    assert.equal(result.rawExitCode, null)
    assert.match(result.output, /failed to signal process tree with SIGTERM: access denied/)
    assert.equal(state.activeRun, null)
    assert.equal(clock.pendingCount(), 0)
})

test("Windows failed cleanup releases a live child handle before resolving", async () => {
    let child = null
    let guardTimer = null
    let killFixture = null
    let unrefCalls = 0
    const state = { activeRun: null, interruptedBy: null }

    try {
        const startedAt = Date.now()
        const result = await Promise.race([
            runCommand({
                args: ["-e", "setInterval(() => {}, 1000)"],
                command: "long-lived-node-fixture",
                executable: process.execPath,
                timeoutMs: 25,
            }, state, {
                platform: "win32",
                spawn(executable, args, options) {
                    child = spawn(executable, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
                    killFixture = child.kill.bind(child)
                    child.kill = () => false
                    const unref = child.unref.bind(child)
                    child.unref = () => {
                        unrefCalls++
                        return unref()
                    }
                    return child
                },
                spawnSync() {
                    return { status: 1, stderr: "taskkill unavailable" }
                },
                windowsFallbackAfterMs: 25,
            }),
            new Promise((_, reject) => {
                guardTimer = setTimeout(
                    () => reject(new Error("runCommand did not release the child handle")),
                    2000,
                )
            }),
        ])
        clearTimeout(guardTimer)
        guardTimer = null

        assert.ok(Date.now() - startedAt < 2000)
        assert.equal(result.cleanupError, true)
        assert.equal(result.rawExitCode, null)
        assert.equal(result.timedOut, true)
        assert.match(result.output, /taskkill unavailable/)
        assert.match(result.output, /child\.kill returned false/)
        assert.equal(child.stdin.destroyed, true)
        assert.equal(child.stdout.destroyed, true)
        assert.equal(child.stderr.destroyed, true)
        assert.equal(child.stdout.listenerCount("data"), 0)
        assert.equal(child.stderr.listenerCount("data"), 0)
        assert.equal(child.listenerCount("close"), 0)
        assert.equal(child.listenerCount("error"), 0)
        assert.equal(unrefCalls, 1)
        assert.equal(state.activeRun, null)
        assert.equal(isProcessAlive(child.pid), true)
    } finally {
        if (guardTimer !== null) clearTimeout(guardTimer)
        if (child?.pid && isProcessAlive(child.pid)) {
            killFixture?.("SIGKILL")
            assert.equal(await waitForProcessExit(child.pid), true)
        }
    }
})

test("Windows signal handlers force the tree once without scheduling cleanup", async () => {
    const clock = createFakeClock()
    const processTarget = new EventEmitter()
    const taskkillCalls = []
    const state = {
        activeRun: {
            child: createFakeChild(99),
            cleanupErrors: [],
            processGroupId: 99,
        },
        interruptedBy: null,
    }
    const removeHandlers = installSignalHandlers(state, {
        platform: "win32",
        processTarget,
        setTimeout: clock.setTimeout,
        spawnSync(command, args) {
            taskkillCalls.push([command, args])
            return { status: 0, stderr: "" }
        },
    })

    processTarget.emit("SIGINT")
    await removeHandlers()

    assert.equal(state.interruptedBy, "SIGINT")
    assert.deepEqual(taskkillCalls, [["taskkill", ["/PID", "99", "/T", "/F"]]])
    assert.equal(clock.pendingCount(), 0)
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
                {
                    identity: `process-${process.pid}`,
                    pgid: 999999,
                    pid: process.pid,
                    ppid: 1,
                },
                {
                    identity: `process-${runnerPid}`,
                    pgid: runnerPid,
                    pid: runnerPid,
                    ppid: process.pid,
                },
                {
                    identity: `process-${nestedPids.test}`,
                    pgid: nestedPids.test,
                    pid: nestedPids.test,
                    ppid: runnerPid,
                },
                {
                    identity: `process-${nestedPids.descendant}`,
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

test("keeps ring storage bounded across many one-byte chunks", () => {
    const tail = createTailBuffer(1024)
    const summary = "Summary: passed=3 failed=0 skipped=1 total=1ms\n"

    for (let index = 0; index < 1000000; index++) tail.append(Buffer.from("x"))
    tail.append(summary)
    const output = tail.toString()

    assert.equal(tail.storageBytes, 1024)
    assert.equal(tail.storageSegments, 1)
    assert.ok(Buffer.byteLength(output) <= 1024)
    assert.deepEqual(parseRunnerSummary(output), { failed: 0, passed: 3, skipped: 1 })
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
