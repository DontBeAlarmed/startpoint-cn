"use strict"

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const { PassThrough } = require("node:stream")
const test = require("node:test")

const {
    MultiHubProcessHarness,
    preparedTcpEndpoint,
} = require("./helpers/multi-hub-process-harness")

const projectRoot = path.resolve(__dirname, "..")

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function settleWithin(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("socket 终止后 waiter 仍等待各自的超时 timer")),
            timeoutMs,
        )
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}

function listen(server, host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen({ host, port: 0 }, () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function compiledTableRegistryFixture(harness) {
    const sourceRoot = path.join(harness.root, "compiled-table-sources")
    fs.mkdirSync(sourceRoot, { recursive: true })
    return {
        TABLE_SOURCES: [
            ["advent_event_quest.json", "1001"],
            ["challenge_dungeon_event_quest.json", "2001"],
        ].map(([tableName, questId]) => {
            const source = path.join(sourceRoot, tableName)
            fs.writeFileSync(source, JSON.stringify({ [questId]: {} }))
            return {
                tableName,
                bundledPath: path.relative(projectRoot, source),
            }
        }),
    }
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        if (!server.listening) {
            resolve()
            return
        }
        server.close(error => error ? reject(error) : resolve())
    })
}

async function waitFor(condition, message, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(10)
    }
    assert.fail(message)
}

function activeTrackedHandles(tracked) {
    return process._getActiveHandles().filter(handle => tracked.has(handle))
}

async function assertTrackedHandlesClosed(tracked) {
    await waitFor(
        () => activeTrackedHandles(tracked).length === 0,
        "测试创建的 TCP handle 未在限定时间内关闭",
    )
}

async function openTestPeer(t, label) {
    const harness = new MultiHubProcessHarness()
    const acceptedSockets = new Set()
    const server = net.createServer(socket => {
        acceptedSockets.add(socket)
        socket.on("close", () => acceptedSockets.delete(socket))
    })
    let cleanupPromise
    const cleanup = () => {
        if (!cleanupPromise) cleanupPromise = (async () => {
            for (const socket of acceptedSockets) socket.destroy()
            await harness.cleanup()
            await closeServer(server)
        })()
        return cleanupPromise
    }
    t.after(cleanup)
    try {
        await listen(server)
        const peer = await harness.openTcp(
            label,
            "127.0.0.1",
            server.address().port,
            { label },
        )
        await waitFor(() => acceptedSockets.size === 1, "测试 TCP 服务未接受连接")
        return { cleanup, peer, server, serverSocket: [...acceptedSockets][0] }
    } catch (error) {
        await cleanup()
        throw error
    }
}

async function assertConcurrentWaitersReject(peer, terminate, expectedError) {
    const timeoutMs = 500
    const waiters = [1, 2, 3].map(index => peer.waitFor(
        message => message[0] === 99 && message[1] === index,
        timeoutMs,
    ))
    const waiterTimers = peer.waiters.map(waiter => waiter.timer)
    const settled = Promise.allSettled(waiters)

    terminate()

    const result = await settleWithin(settled, 100)
    assert.equal(result.length, waiters.length)
    for (const outcome of result) {
        assert.equal(outcome.status, "rejected")
        if (expectedError) assert.equal(outcome.reason, expectedError)
    }
    assert.equal(peer.waiters.length, 0)
    for (const timer of waiterTimers) assert.equal(timer._destroyed, true)
}

test("compiled runtime build succeeds before reading generated table registry", async () => {
    const events = []
    let registry
    const harness = new MultiHubProcessHarness({
        buildCompiledRuntime: () => {
            events.push("build")
            return 0
        },
        loadCompiledTableRegistry: () => {
            events.push("read")
            return registry
        },
    })
    try {
        registry = compiledTableRegistryFixture(harness)
        harness.installRuntimeTables()
        harness.ensureCompiledRuntime()
        assert.deepEqual(events, ["build", "read"])
    } finally {
        await harness.cleanup()
    }
})

test("compiled runtime build failure prevents generated output reads", async () => {
    let readAttempted = false
    const harness = new MultiHubProcessHarness({
        buildCompiledRuntime: () => 7,
        loadCompiledTableRegistry: () => {
            readAttempted = true
            return { TABLE_SOURCES: [] }
        },
    })
    try {
        assert.throws(
            () => harness.installRuntimeTables(),
            /compiled CN build failed with exit code 7/,
        )
        assert.equal(readAttempted, false)
    } finally {
        await harness.cleanup()
    }
})

test("prepare endpoint validation rejects incomplete or unsafe TCP destinations", () => {
    const response = {
        status: 200,
        body: { data: { room_number: "123456", ip_address: "hub.test", port: 8003 } },
    }
    assert.deepEqual(preparedTcpEndpoint(response, "123456"), {
        host: "hub.test",
        port: 8003,
    })
    for (const [field, value] of [
        ["ip_address", ""],
        ["ip_address", 127],
        ["port", "8003"],
        ["port", 0],
        ["port", 65_536],
    ]) {
        assert.throws(
            () => preparedTcpEndpoint({
                ...response,
                body: { data: { ...response.body.data, [field]: value } },
            }, "123456"),
            /prepare TCP endpoint/,
        )
    }
    assert.throws(() => preparedTcpEndpoint(response, "654321"), /prepare room number/)
})

test("cleanup times out stuck peers before stopping runtimes and removing its root", async t => {
    const harness = new MultiHubProcessHarness({ peerCleanupTimeoutMs: 10 })
    const root = harness.root
    let rejectLateClose
    let runtimeStopCalls = 0
    const unhandled = []
    const onUnhandled = error => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    t.after(() => {
        process.off("unhandledRejection", onUnhandled)
        fs.rmSync(root, { recursive: true, force: true })
    })
    harness.peers.push(
        { close: () => new Promise(() => {}) },
        { close: () => new Promise((resolve, reject) => { rejectLateClose = reject }) },
    )
    harness.processes.push({
        async stop() {
            runtimeStopCalls += 1
        },
    })

    const cleanupOutcome = harness.cleanup().then(
        () => ({ status: "fulfilled" }),
        error => ({ status: "rejected", error }),
    )
    const outcome = await Promise.race([
        cleanupOutcome,
        delay(100).then(() => ({ status: "test-timeout" })),
    ])

    assert.equal(runtimeStopCalls, 1)
    assert.equal(outcome.status, "rejected")
    assert.equal(outcome.error instanceof AggregateError, true)
    assert.equal(
        outcome.error.errors.every(error => /peer cleanup timed out/.test(error.message)),
        true,
    )
    assert.equal(fs.existsSync(root), false)
    rejectLateClose(new Error("late peer close failure"))
    await delay(20)
    assert.deepEqual(unhandled, [])
})

test("cleanup closes peers, stops runtimes, and removes its root normally", async () => {
    const harness = new MultiHubProcessHarness({ peerCleanupTimeoutMs: 50 })
    const root = harness.root
    const calls = []
    harness.peers.push({ close: async () => calls.push("peer") })
    harness.processes.push({ stop: async () => calls.push("runtime") })

    await harness.cleanup()

    assert.deepEqual(calls, ["peer", "runtime"])
    assert.equal(fs.existsSync(root), false)
})

test("cleanup owns a runtime created during spawn and stops it before rejecting", async () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const kills = []
    child.kill = signal => {
        kills.push(signal)
        child.signalCode = signal
        queueMicrotask(() => child.emit("close"))
        return true
    }
    let cleanupPromise
    let spawnCalls = 0
    const harness = new MultiHubProcessHarness({
        buildCompiledRuntime: () => 0,
        spawnProcess: () => {
            spawnCalls++
            cleanupPromise = harness.cleanup()
            return child
        },
    })
    let returnedRuntime
    let caught
    try {
        returnedRuntime = harness.spawnRuntime("late-runtime", {}, [])
    } catch (error) {
        caught = error
    } finally {
        if (returnedRuntime) await returnedRuntime.stop()
        if (!cleanupPromise) cleanupPromise = harness.cleanup()
        await cleanupPromise
    }
    assert.equal(spawnCalls, 1)
    assert.match(caught?.message ?? "", /cleanup/)
    assert.deepEqual(kills, ["SIGTERM"])
    assert.equal(harness.processes.filter(runtime => !runtime.stopped).length, 0)
})

test("cleanup destroys a connecting socket and openTcp rejects at the lifecycle boundary", async () => {
    const socket = new EventEmitter()
    socket.destroyed = false
    socket.setEncoding = () => {}
    socket.write = () => true
    socket.destroy = () => {
        if (socket.destroyed) return
        socket.destroyed = true
        queueMicrotask(() => socket.emit("close"))
    }
    const harness = new MultiHubProcessHarness({ createConnection: () => socket })
    const opening = harness.openTcp("late-peer", "127.0.0.1", 1, {})

    await harness.cleanup()

    await assert.rejects(opening, /cleanup/)
    assert.equal(socket.destroyed, true)
    assert.equal(harness.peers.length, 0)
})

test("spawnRuntime rejects after cleanup without creating another process", async () => {
    let spawnCalls = 0
    const harness = new MultiHubProcessHarness({
        buildCompiledRuntime: () => 0,
        spawnProcess: () => {
            spawnCalls++
            throw new Error("spawn must not run after cleanup")
        },
    })
    await harness.cleanup()

    let returnedRuntime
    let caught
    try {
        returnedRuntime = harness.spawnRuntime("late-runtime", {}, [])
    } catch (error) {
        caught = error
    } finally {
        if (returnedRuntime) await returnedRuntime.stop()
    }
    assert.match(caught?.message ?? "", /cleanup/)
    assert.equal(spawnCalls, 0)
})

test("compiled runtime receives its caller-owned timeout", async () => {
    let buildOptions
    const harness = new MultiHubProcessHarness({
        buildCompiledRuntime: options => {
            buildOptions = options
            return 7
        },
    })
    try {
        assert.throws(
            () => harness.installRuntimeTables({ timeoutMs: 25 }),
            /compiled CN build failed with exit code 7/,
        )
        assert.deepEqual(buildOptions, { timeoutMs: 25 })
    } finally {
        await harness.cleanup()
    }
})

test("credential creation has a finite timeout and redacts failed process output", async () => {
    const calls = []
    const harness = new MultiHubProcessHarness({
        credentialTimeoutMs: 25,
        spawnSync: (...args) => {
            calls.push(args)
            return {
                error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
                signal: "SIGTERM",
                status: null,
                stderr: "token-device-path-raw",
                stdout: "token-device-path-raw",
            }
        },
    })
    try {
        assert.throws(
            () => harness.createCredential("finite-label"),
            error => {
                assert.match(error.message, /credential creation timed out/)
                assert.doesNotMatch(error.message, /token|device|path|raw/)
                return true
            },
        )
        assert.equal(calls.length, 1)
        assert.equal(calls[0][2].timeout, 25)
    } finally {
        await harness.cleanup()
    }
})

test("HTTP helpers attach a finite AbortSignal to health, game, and JSON requests", async t => {
    const harness = new MultiHubProcessHarness({ requestTimeoutMs: 50 })
    const originalFetch = global.fetch
    const signals = []
    global.fetch = async (url, init = {}) => {
        signals.push(init.signal)
        if (url.endsWith("/healthz")) {
            return { status: 200, json: async () => ({ status: "ok" }) }
        }
        if (url.endsWith("/game")) {
            return {
                headers: new Headers({ "content-type": "application/json" }),
                status: 200,
                text: async () => "{}",
            }
        }
        return { status: 200, json: async () => ({ ok: true }) }
    }
    t.after(async () => {
        global.fetch = originalFetch
        await harness.cleanup()
    })
    const runtime = { child: { exitCode: null, signalCode: null } }

    await harness.waitForHealth("http://runtime.test", runtime, 50)
    await harness.gamePost("http://runtime.test", "/game", {})
    await harness.json("http://runtime.test", "/json")

    assert.equal(signals.length, 3)
    assert.equal(signals.every(signal => signal instanceof AbortSignal), true)
})

test("openTcp connects to the host returned by the prepared endpoint", async t => {
    const harness = new MultiHubProcessHarness()
    const server = net.createServer(socket => socket.on("data", () => socket.end()))
    t.after(async () => {
        await harness.cleanup()
        await closeServer(server)
    })
    await listen(server, "::1")
    const peer = await harness.openTcp(
        "prepared-host",
        "::1",
        server.address().port,
        { label: "prepared-host" },
    )
    await peer.close()
})

test("remote close immediately settles every waiter and cleanup closes tracked handles", async t => {
    const { cleanup, server, peer, serverSocket } = await openTestPeer(t, "remote-close")
    const tracked = new Set([server, peer.socket, serverSocket])
    try {
        await assertConcurrentWaitersReject(peer, () => serverSocket.destroy())
        const terminalError = peer.terminalError
        await assert.rejects(peer.waitFor(() => true), error => error === terminalError)
        await peer.close()
        await peer.close()
        assert.equal(peer.terminalError, terminalError)
    } finally {
        serverSocket.destroy()
        await cleanup()
        await cleanup()
    }
    await assertTrackedHandlesClosed(tracked)
})

test("socket error deterministically settles concurrent waiters only once", async t => {
    const { cleanup, server, peer, serverSocket } = await openTestPeer(t, "socket-error")
    const tracked = new Set([server, peer.socket, serverSocket])
    const socketError = new Error("test socket failure")
    try {
        await assertConcurrentWaitersReject(
            peer,
            () => peer.socket.destroy(socketError),
            socketError,
        )
        peer.socket.emit("error", new Error("duplicate socket failure"))
        await assert.rejects(peer.waitFor(() => true), error => error === socketError)
        await peer.close()
        await peer.close()
        assert.equal(peer.terminalError, socketError)
    } finally {
        serverSocket.destroy()
        await cleanup()
        await cleanup()
    }
    await assertTrackedHandlesClosed(tracked)
})
