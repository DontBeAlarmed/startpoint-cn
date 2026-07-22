const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const net = require("node:net")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { sessionManager } = require("../src/multi/state/SessionManager")
const { getRoomCleanupStatus } = require("../src/multi/room/manager")
const { getLobbyLifecycleStatus } = require("../src/multi/tcp/lobby-lifecycle")
const {
    getSessionServerStatus,
    isSessionServerListening,
    startSessionServer,
    stopSessionServer,
} = require("../src/multi/tcp/server")

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

function waitFor(predicate, message, timeoutMs = 2_000) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) {
                resolve()
                return
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(message))
                return
            }
            setTimeout(poll, 5)
        }
        poll()
    })
}

function delay(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs))
}

function listen(server, options) {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(options, () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
    })
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port })
        socket.once("connect", () => resolve(socket))
        socket.once("error", reject)
    })
}

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyCalls = 0
        this.destroyed = false
        this.writable = true
    }

    setEncoding() {}

    write() {
        return true
    }

    destroy() {
        this.destroyCalls++
        if (this.destroyed) return this
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
    }
}

class FakeServer extends EventEmitter {
    constructor(connectionListener) {
        super()
        this.connectionListener = connectionListener
        this.listening = false
        this.listenCalls = 0
        this.closeCalls = 0
    }

    listen(_port, _host, callback) {
        this.listenCalls++
        this.listening = true
        queueMicrotask(callback)
        return this
    }

    close(callback) {
        this.closeCalls++
        this.listening = false
        queueMicrotask(callback)
        return this
    }

    accept(socket) {
        this.connectionListener(socket)
    }
}

test.afterEach(async () => {
    await stopSessionServer()
    const status = getSessionServerStatus()
    assert.equal(status.phase, "stopped")
    assert.equal(status.listening, false)
    assert.equal(status.activeSockets, 0)
    assert.equal(status.pendingHandshakes, 0)
})

test("port conflict rejects, clears failed startup state, and permits retry", async () => {
    const blocker = net.createServer()
    await listen(blocker, { host: "127.0.0.1", port: 0 })
    const address = blocker.address()
    assert.ok(address && typeof address === "object")

    await assert.rejects(
        startSessionServer({ host: "127.0.0.1", port: address.port }),
        error => error.code === "EADDRINUSE",
    )
    assert.deepEqual(getSessionServerStatus(), {
        phase: "failed",
        listening: false,
        activeSockets: 0,
        pendingHandshakes: 0,
        lastFailure: { stage: "startup", code: "EADDRINUSE" },
    })
    await closeServer(blocker)
    await startSessionServer({ host: "127.0.0.1", port: address.port })
    assert.equal(isSessionServerListening(), true)
    assert.equal(getSessionServerStatus().phase, "listening")

    await stopSessionServer()
    const rebound = net.createServer()
    await listen(rebound, { host: "127.0.0.1", port: address.port })
    await closeServer(rebound)
})

test("stop destroys an accepted socket that has not completed a handshake", async () => {
    let actualServer
    await startSessionServer({
        host: "127.0.0.1",
        port: 0,
        createServer(connectionListener) {
            actualServer = net.createServer(connectionListener)
            return actualServer
        },
    })
    const address = actualServer.address()
    assert.ok(address && typeof address === "object")
    const client = await connect(address.port)
    await waitFor(
        () => getSessionServerStatus().activeSockets === 1,
        "accepted socket was not tracked",
    )

    await stopSessionServer()
    await waitFor(() => client.destroyed, "client socket was not closed")
    assert.equal(getSessionServerStatus().activeSockets, 0)

    const rebound = net.createServer()
    await listen(rebound, { host: "127.0.0.1", port: address.port })
    await closeServer(rebound)
})

test("stop waits for tracked handshakes, removes late sessions, and ignores new messages", async t => {
    const handshake = deferred()
    const servers = []
    let handshakeCalls = 0
    let lateClient
    t.after(() => {
        if (lateClient && sessionManager.getClient(91, "pending-room")) {
            sessionManager.removeClient(lateClient)
        }
    })
    const startPromise = startSessionServer({
        createServer(connectionListener) {
            const fakeServer = new FakeServer(connectionListener)
            servers.push(fakeServer)
            return fakeServer
        },
        async handleHandshake(socket) {
            handshakeCalls++
            await handshake.promise
            lateClient = sessionManager.createClient(socket, 91, "pending-room", "pending-cid", null)
            sessionManager.addClientToRoom(lateClient)
        },
    })
    assert.equal(getSessionServerStatus().phase, "starting")
    assert.deepEqual(getRoomCleanupStatus(), { running: false })
    assert.equal(startSessionServer(), startPromise)
    await startPromise
    assert.equal(servers.length, 1)
    assert.deepEqual(getRoomCleanupStatus(), { running: true })
    assert.deepEqual(getLobbyLifecycleStatus(), { running: true, activeTimers: 0 })

    const socket = new FakeSocket()
    servers[0].accept(socket)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 1,
        "handshake was not tracked",
    )

    let stopped = false
    const stopPromise = stopSessionServer()
    void stopPromise.then(() => { stopped = true })
    assert.equal(stopSessionServer(), stopPromise)
    const rejectedSocket = new FakeSocket()
    servers[0].accept(rejectedSocket)
    assert.equal(rejectedSocket.destroyCalls, 1)
    assert.equal(getSessionServerStatus().activeSockets, 0)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(handshakeCalls, 1)
    assert.equal(socket.destroyCalls, 1)
    assert.equal(stopped, false)

    handshake.resolve()
    await stopPromise
    assert.equal(stopped, true)
    assert.equal(servers[0].closeCalls, 1)
    assert.equal(sessionManager.getClient(91, "pending-room"), undefined)
    assert.deepEqual(getRoomCleanupStatus(), { running: false })
    assert.deepEqual(getLobbyLifecycleStatus(), { running: false, activeTimers: 0 })
})

test("socket error and close share exactly one session cleanup", async () => {
    let fakeServer
    const originalRemoveClientBySocket = sessionManager.removeClientBySocket
    let cleanupCalls = 0
    sessionManager.removeClientBySocket = () => {
        cleanupCalls++
        return true
    }

    try {
        await startSessionServer({
            createServer(connectionListener) {
                fakeServer = new FakeServer(connectionListener)
                return fakeServer
            },
        })
        const socket = new FakeSocket()
        fakeServer.accept(socket)

        socket.emit("error", new Error("injected socket failure"))
        socket.emit("close")

        assert.equal(cleanupCalls, 1)
        assert.equal(getSessionServerStatus().activeSockets, 0)
    } finally {
        sessionManager.removeClientBySocket = originalRemoveClientBySocket
    }
})

test("synchronous server creation failures reject and repeated stop is idempotent", async () => {
    const originalError = new Error("injected createServer failure")
    await assert.rejects(
        startSessionServer({
            createServer() {
                throw originalError
            },
        }),
        error => error === originalError,
    )
    assert.equal(getSessionServerStatus().phase, "failed")

    const firstStop = stopSessionServer()
    const secondStop = stopSessionServer()
    assert.equal(secondStop, firstStop)
    await firstStop
    await stopSessionServer()
})

test("permission errors reject startup and clear the failed server instance", async () => {
    let failedServer
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" })
    await assert.rejects(
        startSessionServer({
            createServer(connectionListener) {
                failedServer = new FakeServer(connectionListener)
                failedServer.listen = function listenWithPermissionError() {
                    queueMicrotask(() => this.emit("error", permissionError))
                    return this
                }
                return failedServer
            },
        }),
        error => error === permissionError,
    )

    assert.deepEqual(getSessionServerStatus(), {
        phase: "failed",
        listening: false,
        activeSockets: 0,
        pendingHandshakes: 0,
        lastFailure: { stage: "startup", code: "EACCES" },
    })
    assert.equal(failedServer.listenerCount("error"), 0)

    let retryServer
    await startSessionServer({
        createServer(connectionListener) {
            retryServer = new FakeServer(connectionListener)
            return retryServer
        },
    })
    assert.equal(retryServer.listening, true)
})

test("startup and close failures finalize a non-listening server and allow restart", async () => {
    let failedServer
    const startupError = new Error("startup event failure")
    const closeError = new Error("startup close failure")
    const startPromise = startSessionServer({
        createServer(connectionListener) {
            failedServer = new FakeServer(connectionListener)
            failedServer.listen = function pendingListen() {
                this.listening = true
                return this
            }
            failedServer.close = function failFirstClose(callback) {
                this.closeCalls++
                this.listening = false
                queueMicrotask(() => callback(this.closeCalls === 1 ? closeError : undefined))
                return this
            }
            return failedServer
        },
    })

    failedServer.emit("error", startupError)
    await assert.rejects(startPromise, error => error === startupError)
    await waitFor(() => failedServer.closeCalls === 1, "startup cleanup did not close the server")
    await new Promise(resolve => setImmediate(resolve))
    const listenersAfterFailure = failedServer.listenerCount("error")
    const phaseAfterFailure = getSessionServerStatus().phase

    let retryServer
    const retryResult = await startSessionServer({
        createServer(connectionListener) {
            retryServer = new FakeServer(connectionListener)
            return retryServer
        },
    }).then(
        () => ({ status: "resolved" }),
        error => ({ status: "rejected", error }),
    )
    if (retryResult.status === "rejected") await stopSessionServer()

    assert.equal(phaseAfterFailure, "failed")
    assert.equal(listenersAfterFailure, 0)
    assert.equal(retryResult.status, "resolved")
    assert.equal(retryServer.listening, true)
})

test("stop during startup rejects the start promise without hanging", async () => {
    let startingServer
    const startPromise = startSessionServer({
        createServer(connectionListener) {
            startingServer = new FakeServer(connectionListener)
            return startingServer
        },
    })

    assert.equal(getSessionServerStatus().phase, "starting")
    const stopPromise = stopSessionServer()
    assert.equal(getSessionServerStatus().phase, "stopping")

    await assert.rejects(startPromise, /startup was stopped/i)
    await stopPromise
    assert.equal(startingServer.closeCalls, 1)
    assert.equal(getSessionServerStatus().phase, "stopped")
})

test("stop during startup keeps a late error handled and settles only once", async () => {
    let lateListen
    let closingCallback
    let startingServer
    const lateError = new Error("late listen failure")
    const startPromise = startSessionServer({
        createServer(connectionListener) {
            startingServer = new FakeServer(connectionListener)
            startingServer.listening = false
            startingServer.listen = function deferredListen(_port, _host, callback) {
                lateListen = callback
                return this
            }
            startingServer.close = function deferredClose(callback) {
                this.closeCalls++
                closingCallback = callback
                return this
            }
            return startingServer
        },
    })

    const stopPromise = stopSessionServer()
    let thrownError
    try {
        startingServer.emit("error", lateError)
    } catch (error) {
        thrownError = error
    }
    lateListen()
    closingCallback()

    const startResult = await startPromise.then(
        () => ({ status: "resolved" }),
        error => ({ status: "rejected", error }),
    )
    const stopResult = await stopPromise.then(
        () => ({ status: "resolved" }),
        error => ({ status: "rejected", error }),
    )

    assert.equal(thrownError, undefined)
    assert.match(startResult.error.message, /startup was stopped/i)
    assert.equal(stopResult.status, "rejected")
    assert.equal(stopResult.error, lateError)
    assert.equal(startingServer.listenerCount("error"), 0)
})

test("close callback errors reject stop and a later stop retries current state", async () => {
    let fakeServer
    const closeError = new Error("close callback failure")
    await startSessionServer({
        createServer(connectionListener) {
            fakeServer = new FakeServer(connectionListener)
            fakeServer.close = function failThenSucceed(callback) {
                this.closeCalls++
                if (this.closeCalls === 1) {
                    this.listening = false
                    queueMicrotask(() => callback(closeError))
                } else {
                    this.listening = false
                    queueMicrotask(() => callback())
                }
                return this
            }
            return fakeServer
        },
    })

    const firstStop = stopSessionServer()
    await assert.rejects(firstStop, error => error === closeError)
    assert.equal(getSessionServerStatus().phase, "failed")

    const retryStop = stopSessionServer()
    assert.notEqual(retryStop, firstStop)
    await retryStop
    assert.equal(fakeServer.closeCalls, 1)
    assert.equal(fakeServer.listenerCount("error"), 0)
    assert.equal(getSessionServerStatus().phase, "stopped")
})

test("server error during close rejects stop, removes close listeners, and permits retry", async () => {
    let fakeServer
    const closeError = new Error("close event failure")
    await startSessionServer({
        createServer(connectionListener) {
            fakeServer = new FakeServer(connectionListener)
            fakeServer.close = function failByEventThenSucceed(callback) {
                this.closeCalls++
                if (this.closeCalls === 1) {
                    queueMicrotask(() => this.emit("error", closeError))
                    setTimeout(() => callback(), 20)
                } else {
                    this.listening = false
                    queueMicrotask(() => callback())
                }
                return this
            }
            return fakeServer
        },
    })

    const firstStop = stopSessionServer()
    await assert.rejects(firstStop, error => error === closeError)
    assert.equal(fakeServer.listenerCount("error"), 1)
    assert.equal(getSessionServerStatus().phase, "failed")

    await stopSessionServer()
    await delay(25)
    assert.equal(fakeServer.closeCalls, 2)
    assert.equal(fakeServer.listenerCount("error"), 0)
    assert.equal(getSessionServerStatus().phase, "stopped")
})

test("handshake shutdown timeout bounds stop and late resolution cannot add a session", async t => {
    const handshake = deferred()
    let fakeServer
    let lateClient
    t.after(() => {
        if (lateClient && sessionManager.getClient(92, "timeout-room")) {
            sessionManager.removeClient(lateClient)
        }
    })
    await startSessionServer({
        shutdownTimeoutMs: 20,
        createServer(connectionListener) {
            fakeServer = new FakeServer(connectionListener)
            return fakeServer
        },
        async handleHandshake(socket, _data, lifecycle) {
            await handshake.promise
            if (!lifecycle.isAccepting()) return
            lateClient = sessionManager.createClient(socket, 92, "timeout-room", "timeout-cid", null)
            sessionManager.addClientToRoom(lateClient)
        },
    })
    const socket = new FakeSocket()
    fakeServer.accept(socket)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 1,
        "handshake was not tracked",
    )

    const stopPromise = stopSessionServer()
    const firstResult = await Promise.race([
        stopPromise.then(() => "stopped"),
        delay(100).then(() => "timed-out"),
    ])
    const statusBeforeResolution = getSessionServerStatus()

    let replacementServer
    await startSessionServer({
        createServer(connectionListener) {
            replacementServer = new FakeServer(connectionListener)
            return replacementServer
        },
    })
    handshake.resolve()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(firstResult, "stopped")
    assert.deepEqual(statusBeforeResolution, {
        phase: "stopped",
        listening: false,
        activeSockets: 0,
        pendingHandshakes: 0,
        lastFailure: null,
    })
    assert.equal(sessionManager.getClient(92, "timeout-room"), undefined)
    assert.equal(replacementServer.listening, true)
    await stopSessionServer()
})

test("handshake shutdown deadline is unrefed, cleared, and still settles stop", async () => {
    const handshake = deferred()
    let fakeServer
    await startSessionServer({
        shutdownTimeoutMs: 20,
        createServer(connectionListener) {
            fakeServer = new FakeServer(connectionListener)
            return fakeServer
        },
        async handleHandshake() {
            await handshake.promise
        },
    })
    const socket = new FakeSocket()
    fakeServer.accept(socket)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 1,
        "handshake was not tracked",
    )

    const originalSetTimeout = global.setTimeout
    const originalClearTimeout = global.clearTimeout
    const keepAlive = originalSetTimeout(() => {}, 200)
    let shutdownTimer
    let cleared = false
    global.setTimeout = function captureShutdownTimer(callback, delayMs, ...args) {
        const timer = originalSetTimeout(callback, delayMs, ...args)
        if (delayMs === 20) shutdownTimer = timer
        return timer
    }
    global.clearTimeout = function captureClear(timer) {
        if (timer === shutdownTimer) cleared = true
        return originalClearTimeout(timer)
    }

    const startedAt = Date.now()
    let stopError
    try {
        const stopPromise = stopSessionServer()
        const hasRefAfterCreation = shutdownTimer?.hasRef()
        await stopPromise.catch(error => { stopError = error })
        const elapsedMs = Date.now() - startedAt

        assert.equal(stopError, undefined)
        assert.equal(hasRefAfterCreation, false)
        assert.equal(cleared, true)
        assert.ok(elapsedMs >= 10 && elapsedMs < 100, `unexpected shutdown duration: ${elapsedMs}ms`)
    } finally {
        global.setTimeout = originalSetTimeout
        global.clearTimeout = originalClearTimeout
        originalClearTimeout(keepAlive)
        handshake.resolve()
        await new Promise(resolve => setImmediate(resolve))
    }
})

test("runtime server errors perform fatal teardown, retain safe diagnostics, and allow restart", async () => {
    const handshake = deferred()
    const fatalFailures = []
    let applicationStopPromise
    let runtimeServer
    await startSessionServer({
        host: "127.0.0.1",
        port: 0,
        shutdownTimeoutMs: 20,
        createServer(connectionListener) {
            runtimeServer = net.createServer(connectionListener)
            return runtimeServer
        },
        async handleHandshake() {
            await handshake.promise
        },
        onFatalError(failure) {
            fatalFailures.push(failure)
            applicationStopPromise = stopSessionServer()
            void applicationStopPromise.catch(() => {})
            throw new Error("application fatal callback detail")
        },
    })
    const address = runtimeServer.address()
    assert.ok(address && typeof address === "object")
    const client = await connect(address.port)
    client.write(`${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 1,
        "runtime handshake was not tracked",
    )
    assert.deepEqual(getRoomCleanupStatus(), { running: true })
    assert.deepEqual(getLobbyLifecycleStatus(), { running: true, activeTimers: 0 })

    const runtimeError = Object.assign(new Error("must-not-appear-sensitive-detail"), {
        code: "E_RUNTIME_TEST",
    })
    const closePhaseError = Object.assign(new Error("close-phase-detail"), {
        code: "E_RUNTIME_CLOSE_TEST",
    })
    const originalRuntimeClose = runtimeServer.close.bind(runtimeServer)
    let runtimeCloseCalls = 0
    runtimeServer.close = function countRuntimeClose(callback) {
        runtimeCloseCalls++
        return originalRuntimeClose(callback)
    }
    runtimeServer.emit("error", runtimeError)
    runtimeServer.emit("error", closePhaseError)
    const immediateStatus = getSessionServerStatus()
    const fatalCompleted = await waitFor(
        () => {
            const status = getSessionServerStatus()
            return status.phase === "failed"
                && status.activeSockets === 0
                && status.pendingHandshakes === 0
                && runtimeServer.listenerCount("error") === 0
                && !runtimeServer.listening
        },
        "runtime fatal teardown did not complete",
        120,
    ).then(() => true, () => false)
    const failedStatus = getSessionServerStatus()
    const roomStatus = getRoomCleanupStatus()
    const lobbyStatus = getLobbyLifecycleStatus()
    const clientDestroyed = client.destroyed

    let rebound = false
    let restartStatus
    if (fatalCompleted) {
        const reboundServer = net.createServer()
        await listen(reboundServer, { host: "127.0.0.1", port: address.port })
        rebound = true
        await closeServer(reboundServer)

        await startSessionServer({ host: "127.0.0.1", port: address.port })
        restartStatus = getSessionServerStatus()
        await stopSessionServer()
    } else {
        handshake.resolve()
        await stopSessionServer()
    }
    handshake.resolve()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(immediateStatus.phase, "failed")
    assert.equal(immediateStatus.listening, false)
    assert.deepEqual(immediateStatus.lastFailure, { stage: "runtime", code: "E_RUNTIME_TEST" })
    assert.equal(JSON.stringify(immediateStatus).includes(runtimeError.message), false)
    assert.deepEqual(fatalFailures, [{ stage: "runtime", code: "E_RUNTIME_TEST" }])
    assert.ok(applicationStopPromise)
    await assert.rejects(
        applicationStopPromise,
        error => error.code === "E_RUNTIME_CLOSE_TEST",
    )
    assert.equal(fatalCompleted, true)
    assert.deepEqual(failedStatus, {
        phase: "failed",
        listening: false,
        activeSockets: 0,
        pendingHandshakes: 0,
        lastFailure: { stage: "runtime", code: "E_RUNTIME_TEST" },
    })
    assert.deepEqual(roomStatus, { running: false })
    assert.deepEqual(lobbyStatus, { running: false, activeTimers: 0 })
    assert.equal(clientDestroyed, true)
    assert.equal(runtimeCloseCalls, 1)
    assert.equal(rebound, true)
    assert.deepEqual(restartStatus, {
        phase: "listening",
        listening: true,
        activeSockets: 0,
        pendingHandshakes: 0,
        lastFailure: null,
    })
})
