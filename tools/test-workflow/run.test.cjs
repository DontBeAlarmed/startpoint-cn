const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { once } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    MAX_PARALLEL_TESTS,
    buildGitCommands,
    classifyTestOutput,
    executeTestGroups,
    installSignalHandlers,
    main,
    mergeChangedFiles,
    parseArguments,
    runParallel,
    summarizeResults,
} = require("./run.cjs")

const grandchildCode = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'

function killProcessGroup(processGroupId) {
    try {
        process.kill(-processGroupId, "SIGKILL")
    } catch (error) {
        if (error.code !== "ESRCH") throw error
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

async function waitForProcessExit(pid, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    return !isProcessAlive(pid)
}

function createDeferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

async function waitForCondition(condition, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail("condition was not met before timeout")
}

test("parses group, files, and changed modes", () => {
    assert.deepEqual(parseArguments(["--group", "quick:gacha"]), {
        mode: "group",
        group: "quick:gacha",
        files: [],
        base: null,
    })
    assert.deepEqual(parseArguments(["--files", "src/lib/gacha.ts", "admin/src/App.tsx"]), {
        mode: "files",
        group: null,
        files: ["src/lib/gacha.ts", "admin/src/App.tsx"],
        base: null,
    })
    assert.deepEqual(parseArguments(["--changed", "--base", "origin/main"]), {
        mode: "changed",
        group: null,
        files: [],
        base: "origin/main",
    })
})

test("rejects conflicting selectors and base without changed", () => {
    assert.throws(
        () => parseArguments(["--group", "quick", "--changed"]),
        /exactly one/i,
    )
    assert.throws(() => parseArguments(["--base", "main"]), /requires --changed/i)
    assert.throws(
        () => parseArguments(["--changed", "--base", "-invalid-ref"]),
        /requires a git ref/i,
    )
})

test("terminates every git path command with a double dash", () => {
    assert.deepEqual(buildGitCommands("origin/main"), [
        ["diff", "--name-only", "--cached", "--"],
        ["diff", "--name-only", "--"],
        ["ls-files", "--others", "--exclude-standard", "--"],
        ["diff", "--name-only", "origin/main...HEAD", "--"],
    ])
})

test("merges changed file sources with stable sorting and deduplication", () => {
    assert.deepEqual(
        mergeChangedFiles([
            ["src/z.ts", "src/a.ts"],
            ["src/a.ts", "admin/src/App.tsx"],
            ["src/new.ts"],
        ]),
        ["admin/src/App.tsx", "src/a.ts", "src/new.ts", "src/z.ts"],
    )
})

test("preserves input order when parallel operations finish in reverse order", async () => {
    const items = Array.from({ length: MAX_PARALLEL_TESTS }, (_, index) => index)
    const completionOrder = []

    const results = await runParallel(items, MAX_PARALLEL_TESTS, async item => {
        await new Promise(resolve => setTimeout(resolve, (items.length - item) * 20))
        completionOrder.push(item)
        return item * 2
    }, () => false)

    assert.deepEqual(completionOrder, items.toReversed())
    assert.deepEqual(results, items.map(item => item * 2))
})

test("stops scheduling after the first infrastructure error and waits for workers", async () => {
    const items = Array.from({ length: 10 }, (_, index) => index)
    const releases = Array.from({ length: MAX_PARALLEL_TESTS }, createDeferred)
    const firstBatchStarted = createDeferred()
    const infrastructureError = new Error("parallel fixture failed")
    const started = []
    let outcome = "pending"

    const resultPromise = runParallel(items, MAX_PARALLEL_TESTS, async item => {
        started.push(item)
        if (started.length === MAX_PARALLEL_TESTS) firstBatchStarted.resolve()
        await firstBatchStarted.promise
        if (item === 0) throw infrastructureError
        await releases[item].promise
        return item
    }, () => false)
    const rejection = assert.rejects(resultPromise, error => error === infrastructureError)
    resultPromise.then(
        () => { outcome = "fulfilled" },
        () => { outcome = "rejected" },
    )

    await firstBatchStarted.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome, "pending")
    assert.deepEqual(started, items.slice(0, MAX_PARALLEL_TESTS))

    for (const item of items.slice(1, MAX_PARALLEL_TESTS)) releases[item].resolve()
    await rejection
    assert.equal(outcome, "rejected")
    assert.deepEqual(started, items.slice(0, MAX_PARALLEL_TESTS))
})

test("continues scheduling ordinary failed results", async () => {
    const items = Array.from({ length: 10 }, (_, index) => index)
    const started = []
    const results = await runParallel(items, 2, async item => {
        started.push(item)
        return { item, status: item === 0 ? "failed" : "passed" }
    }, () => false)

    assert.deepEqual(started, items)
    assert.deepEqual(results.map(result => result.status), [
        "failed",
        ...Array.from({ length: 9 }, () => "passed"),
    ])
})

test("reports no changes successfully in a clean worktree", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-git-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    const initialized = spawn("git", ["init", "--quiet"], { cwd: fixtureRoot })
    const [exitCode] = await once(initialized, "close")
    assert.equal(exitCode, 0)

    let output = ""
    const result = await main(["--changed"], {
        cwd: fixtureRoot,
        writeError(value) { output += value },
        writeOutput(value) { output += value },
    })

    assert.equal(result, 0)
    assert.equal(output, "no changes\n")
})

test("does not treat zero skipped tests as a skipped file", () => {
    assert.deepEqual(classifyTestOutput(0, "0 tests were skipped\n"), {
        status: "passed",
        skippedCases: 0,
    })
})

test("counts mixed TAP skips while keeping the file passed", () => {
    const classification = classifyTestOutput(0, [
        "TAP version 13",
        "ok 1 - optional # SKIP unavailable",
        "ok 2 - required",
        "1..2",
        "# tests 2",
        "# pass 1",
        "# skipped 1",
    ].join("\n"))
    assert.deepEqual(classification, {
        status: "passed",
        skippedCases: 1,
    })
    assert.deepEqual(summarizeResults([classification]), {
        passed: 1,
        failed: 0,
        skipped: 1,
    })
})

test("marks a TAP file skipped only when every case is skipped", () => {
    assert.deepEqual(classifyTestOutput(0, [
        "TAP version 13",
        "ok 1 - optional A # SKIP unavailable",
        "ok 2 - optional B # SKIP unavailable",
        "1..2",
        "# tests 2",
        "# pass 0",
        "# skipped 2",
    ].join("\n")), {
        status: "skipped",
        skippedCases: 2,
    })
})

test("supports explicit non-TAP whole-file skips", () => {
    assert.deepEqual(classifyTestOutput(0, "fixture tests skipped: input unavailable\n"), {
        status: "skipped",
        skippedCases: 1,
    })
    assert.deepEqual(classifyTestOutput(0, "测试跳过：缺少可选输入\n"), {
        status: "skipped",
        skippedCases: 1,
    })
    assert.deepEqual(classifyTestOutput(0, "跳过：缺少可选输入\n"), {
        status: "skipped",
        skippedCases: 1,
    })
})

test("rejects unknown groups", async () => {
    await assert.rejects(
        executeTestGroups(["quick:missing"], {
            cwd: process.cwd(),
            testGroups: {},
            writeOutput() {},
        }),
        /unknown group/i,
    )
})

test("rejects a directly selected empty group", async () => {
    await assert.rejects(
        executeTestGroups(["integration:empty"], {
            cwd: process.cwd(),
            testGroups: {
                "integration:empty": { execution: "serial", tests: [] },
            },
            writeOutput() {},
        }),
        /no tests configured/i,
    )
})

test("aggregates passed, failed, and explicitly skipped child processes", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

    fs.writeFileSync(
        path.join(fixtureRoot, "pass.cjs"),
        'require("node:assert/strict").equal(process.env.TS_NODE_TRANSPILE_ONLY, "1")\n',
    )
    fs.writeFileSync(path.join(fixtureRoot, "fail.cjs"), "process.exit(7)\n")
    fs.writeFileSync(
        path.join(fixtureRoot, "skip.cjs"),
        'console.log("fixture tests skipped: optional input unavailable")\n',
    )

    const report = await executeTestGroups(["quick:fixture"], {
        cwd: fixtureRoot,
        testGroups: {
            "quick:fixture": {
                execution: "parallel",
                tests: ["pass.cjs", "fail.cjs", "skip.cjs"],
            },
        },
        writeOutput() {},
    })

    assert.deepEqual(report.summary, { passed: 1, failed: 1, skipped: 1 })
    assert.equal(report.exitCode, 1)
    assert.equal(report.results.find(result => result.file === "fail.cjs").exitCode, 7)
})

test("runs eight real child processes within the parallel limit and clears active children", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-parallel-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    assert.equal(MAX_PARALLEL_TESTS, 8)
    const tests = Array.from({ length: MAX_PARALLEL_TESTS }, (_, index) => `child-${index}.cjs`)
    for (const file of tests) {
        fs.writeFileSync(path.join(fixtureRoot, file), "setTimeout(() => {}, 100)\n")
    }

    let peakActiveChildren = 0
    const activeChildren = new class extends Set {
        add(child) {
            super.add(child)
            peakActiveChildren = Math.max(peakActiveChildren, this.size)
            return this
        }
    }()
    const report = await executeTestGroups(["quick:fixture"], {
        activeChildren,
        cwd: fixtureRoot,
        testGroups: {
            "quick:fixture": { execution: "parallel", tests },
        },
        writeOutput() {},
    })

    assert.equal(peakActiveChildren, MAX_PARALLEL_TESTS)
    assert.ok(peakActiveChildren <= MAX_PARALLEL_TESTS)
    assert.equal(report.results.length, tests.length)
    assert.ok(report.results.every(result => result.status === "passed"))
    assert.equal(activeChildren.size, 0)
})

test("signal stops new child scheduling and waits for all started children", {
    skip: process.platform === "win32",
}, async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-signal-parallel-"))
    const markerRoot = path.join(fixtureRoot, "started")
    fs.mkdirSync(markerRoot)
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    const tests = Array.from({ length: 10 }, (_, index) => `child-${index}.cjs`)
    for (const [index, file] of tests.entries()) {
        fs.writeFileSync(path.join(fixtureRoot, file), [
            'const fs = require("node:fs")',
            `fs.writeFileSync(${JSON.stringify(path.join(markerRoot, String(index)))}, "")`,
            'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25))',
            'setInterval(() => {}, 1000)',
        ].join("\n"))
    }

    const activeChildren = new Set()
    let interrupted = false
    const removeHandlers = installSignalHandlers(
        activeChildren,
        () => { interrupted = true },
        { forceKillAfterMs: 100 },
    )

    try {
        const reportPromise = executeTestGroups(["quick:fixture"], {
            activeChildren,
            cwd: fixtureRoot,
            shouldStop: () => interrupted,
            testGroups: {
                "quick:fixture": {
                    execution: "parallel",
                    forceKillAfterMs: 100,
                    timeoutMs: 2000,
                    tests,
                },
            },
            writeOutput() {},
        })

        await waitForCondition(() => fs.readdirSync(markerRoot).length === MAX_PARALLEL_TESTS)
        process.emit("SIGTERM")
        const report = await reportPromise

        assert.deepEqual(
            fs.readdirSync(markerRoot).sort(),
            Array.from({ length: MAX_PARALLEL_TESTS }, (_, index) => String(index)),
        )
        assert.equal(report.results.length, MAX_PARALLEL_TESTS)
        assert.equal(activeChildren.size, 0)
    } finally {
        for (const child of activeChildren) killProcessGroup(child.pid)
        await removeHandlers()
    }
})

test("times out and terminates a child that keeps handles open", async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-timeout-"))
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    fs.writeFileSync(path.join(fixtureRoot, "hang.cjs"), "setInterval(() => {}, 1000)\n")

    const report = await executeTestGroups(["integration:fixture"], {
        cwd: fixtureRoot,
        testGroups: {
            "integration:fixture": {
                execution: "serial",
                forceKillAfterMs: 50,
                timeoutMs: 100,
                tests: ["hang.cjs"],
            },
        },
        writeOutput() {},
    })

    assert.equal(report.exitCode, 1)
    assert.equal(report.results[0].timedOut, true)
    assert.match(report.results[0].output, /timed out after 100ms/)
})

test("timeout kills a grandchild after its parent exits on SIGTERM", {
    skip: process.platform === "win32",
}, async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-grandchild-"))
    const pidPath = path.join(fixtureRoot, "grandchild.pid")
    const fixturePath = path.join(fixtureRoot, "parent.cjs")
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
    fs.writeFileSync(fixturePath, [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: ["ignore", "pipe", "ignore"] })`,
        `child.stdout.once("data", () => fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)))`,
        'process.on("SIGTERM", () => process.exit(0))',
        'setInterval(() => {}, 1000)',
    ].join("\n"))

    let grandchildPid
    try {
        const report = await executeTestGroups(["integration:fixture"], {
            cwd: fixtureRoot,
            testGroups: {
                "integration:fixture": {
                    execution: "serial",
                    forceKillAfterMs: 200,
                    timeoutMs: 1500,
                    tests: ["parent.cjs"],
                },
            },
            writeOutput() {},
        })
        grandchildPid = Number(fs.readFileSync(pidPath, "utf8"))
        assert.equal(report.results[0].timedOut, true)
        assert.equal(await waitForProcessExit(grandchildPid), true)
    } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
            try { process.kill(grandchildPid, "SIGKILL") } catch {}
        }
    }
})

test("signal cleanup kills a grandchild after its parent exits on SIGTERM", {
    skip: process.platform === "win32",
}, async () => {
    const parent = spawn(process.execPath, [
        "-e",
        [
            'const { spawn } = require("node:child_process")',
            `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: ["ignore", "pipe", "ignore"] })`,
            'child.stdout.once("data", () => console.log(child.pid))',
            'process.on("SIGTERM", () => process.exit(0))',
            'setInterval(() => {}, 1000)',
        ].join(";"),
    ], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
    })
    const [pidOutput] = await once(parent.stdout, "data")
    const grandchildPid = Number(pidOutput.toString().trim())

    const activeChildren = new Set([parent])
    const removeHandlers = installSignalHandlers(
        activeChildren,
        () => {},
        { forceKillAfterMs: 200 },
    )

    try {
        process.emit("SIGTERM")
        await once(parent, "close")
        await removeHandlers()
        assert.equal(await waitForProcessExit(grandchildPid), true)
    } finally {
        killProcessGroup(parent.pid)
        await removeHandlers()
    }
})

test("records process group signal errors without escaping cleanup", async () => {
    const calls = []
    const errors = []
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" })
    const fakeChild = { pid: 424242 }
    const removeHandlers = installSignalHandlers(
        new Set([fakeChild]),
        () => {},
        {
            forceKillAfterMs: 10,
            onSignalError(error, context) {
                errors.push({ error, ...context })
            },
            sendSignal(_child, processGroupId, signal) {
                calls.push({ processGroupId, signal })
                throw denied
            },
        },
    )

    assert.doesNotThrow(() => process.emit("SIGTERM"))
    await removeHandlers()

    assert.deepEqual(calls, [
        { processGroupId: 424242, signal: "SIGTERM" },
        { processGroupId: 424242, signal: "SIGKILL" },
    ])
    assert.deepEqual(errors, [
        { error: denied, processGroupId: 424242, signal: "SIGTERM" },
        { error: denied, processGroupId: 424242, signal: "SIGKILL" },
    ])
})
