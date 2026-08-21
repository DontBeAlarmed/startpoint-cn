"use strict"

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { PassThrough } = require("node:stream")
const test = require("node:test")

const { startOwnedProcess } = require("./multi_hub_load_process_fixture.cjs")

function fakeChild(pid = 4321) {
    const child = new EventEmitter()
    child.pid = pid
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    return child
}

function processMissingError() {
    return Object.assign(new Error("process group missing"), { code: "ESRCH" })
}

function emergencyKillGroup(pgid, killProcess = process.kill) {
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return false
    try {
        killProcess(-pgid, "SIGKILL")
        return true
    } catch (error) {
        if (error?.code === "ESRCH") return false
        throw error
    }
}

function emergencyKillProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, "SIGKILL")
        return true
    } catch (error) {
        if (error?.code === "ESRCH") return false
        throw error
    }
}

test("emergency cleanup negates a positive owned process group", () => {
    const calls = []
    assert.equal(emergencyKillGroup(7654, (pid, signal) => {
        calls.push({ pid, signal })
    }), true)
    assert.deepEqual(calls, [{ pid: -7654, signal: "SIGKILL" }])
})

test("parent close with a live descendant escalates from group TERM to KILL", async () => {
    const child = fakeChild()
    const spawnCalls = []
    const killCalls = []
    let clock = 0
    let descendantAlive = true
    const owner = startOwnedProcess({
        command: "/runtime/node",
        args: ["workload.cjs"],
        cwd: "/project",
        timeoutMs: 5,
        terminationTimeoutMs: 20,
        platform: "darwin",
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds },
        spawnProcess(command, args, options) {
            spawnCalls.push({ command, args, options })
            return child
        },
        killProcess(pid, signal) {
            killCalls.push({ pid, signal })
            if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal))
            if (signal === "SIGKILL") descendantAlive = false
            if (signal === 0 && !descendantAlive) throw processMissingError()
        },
    })

    await assert.rejects(owner.result, /owned process timed out/)
    await owner.cleanup()

    assert.equal(spawnCalls[0].options.detached, true)
    assert.deepEqual(
        killCalls.filter(call => call.signal !== 0),
        [
            { pid: -4321, signal: "SIGTERM" },
            { pid: -4321, signal: "SIGKILL" },
        ],
    )
    assert.equal(killCalls.some(call => call.signal === 0), true)
    assert.equal(child.listenerCount("close"), 0)
    assert.equal(child.listenerCount("error"), 0)
    assert.equal(child.stdout.listenerCount("data"), 0)
    assert.equal(child.stderr.listenerCount("data"), 0)
})

test("owned process cleanup also sweeps a POSIX group after normal exit", async () => {
    const child = fakeChild(5432)
    const killCalls = []
    let groupAlive = true
    const owner = startOwnedProcess({
        command: "/runtime/node",
        timeoutMs: 50,
        terminationTimeoutMs: 20,
        platform: "darwin",
        spawnProcess: () => child,
        killProcess(pid, signal) {
            killCalls.push({ pid, signal })
            if (signal === "SIGTERM") groupAlive = false
            if (signal === 0 && !groupAlive) throw processMissingError()
        },
    })
    queueMicrotask(() => child.emit("close", 0, null))

    const result = await owner.result
    await owner.cleanup()
    await owner.cleanup()

    assert.deepEqual(result, { code: 0, signal: null, stderr: "", stdout: "" })
    assert.deepEqual(
        killCalls.filter(call => call.signal !== 0),
        [{ pid: -5432, signal: "SIGTERM" }],
    )
})

test("process-group probe errors fail closed and retain their cause", async () => {
    const child = fakeChild(6543)
    const permissionError = Object.assign(new Error("probe denied"), { code: "EPERM" })
    const owner = startOwnedProcess({
        command: "/runtime/node",
        timeoutMs: 50,
        terminationTimeoutMs: 5,
        platform: "darwin",
        spawnProcess: () => child,
        killProcess(_pid, signal) {
            if (signal === 0) throw permissionError
        },
    })
    queueMicrotask(() => child.emit("close", 0, null))
    await owner.result

    await assert.rejects(owner.cleanup(), error => {
        assert.equal(error instanceof AggregateError, true)
        assert.equal(error.cause, permissionError)
        assert.equal(error.errors.includes(permissionError), true)
        return true
    })
})

test("real POSIX cleanup kills a TERM-resistant descendant after its parent exits", {
    timeout: 10_000,
    skip: process.platform === "win32" ? "POSIX process-group coverage" : false,
}, async t => {
    const descendantScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const parentScript = [
        "const { spawn } = require('node:child_process')",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
        "process.stdout.write(String(child.pid))",
        "setTimeout(() => process.exit(0), 50)",
    ].join(";")
    const owner = startOwnedProcess({
        command: process.execPath,
        args: ["-e", parentScript],
        timeoutMs: 2_000,
        terminationTimeoutMs: 100,
    })
    let descendantPid
    t.after(() => {
        let groupError
        try {
            emergencyKillGroup(owner.child.pid)
        } catch (error) {
            groupError = error
        }
        emergencyKillProcess(descendantPid)
        if (groupError && groupError.code !== "EPERM") throw groupError
    })
    const result = await owner.result
    descendantPid = Number(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(Number.isSafeInteger(descendantPid), true)

    await owner.cleanup()

    assert.throws(() => process.kill(-owner.child.pid, 0), { code: "ESRCH" })
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" })
})
