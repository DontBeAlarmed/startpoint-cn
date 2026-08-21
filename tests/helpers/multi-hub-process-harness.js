"use strict"

const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")

const Sqlite = require("better-sqlite3")
const { pack, unpack } = require("msgpackr")
const { runCnBuild } = require("../../tools/test-workflow/build-cn.cjs")

const projectRoot = path.resolve(__dirname, "../..")
const defaultCompatibilityHeaders = Object.freeze({
    APP_VER: "1.8.1",
    RES_VER: "1.4.54",
})
const defaultPeerCleanupTimeoutMs = 5_000
const defaultCredentialTimeoutMs = 15_000
const defaultRequestTimeoutMs = 15_000

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function settleWithinTimeout(action, timeoutMs, timeoutMessage) {
    let timer
    const operation = Promise.resolve().then(action).then(
        value => ({ status: "fulfilled", value }),
        reason => ({ status: "rejected", reason }),
    )
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve({
            status: "rejected",
            reason: new Error(timeoutMessage),
        }), timeoutMs)
    })
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

function finiteRequestSignal(signal, timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function preparedTcpEndpoint(response, expectedRoomNumber) {
    if (response?.status !== 200) {
        throw new Error(`prepare TCP endpoint requires HTTP 200, received ${response?.status}`)
    }
    const data = response.body?.data
    if (data?.room_number !== expectedRoomNumber) {
        throw new Error(`prepare room number mismatch: expected ${expectedRoomNumber}`)
    }
    const host = data?.ip_address
    const port = data?.port
    if (typeof host !== "string"
        || host.trim() === ""
        || host !== host.trim()) {
        throw new Error("prepare TCP endpoint requires a non-empty host")
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("prepare TCP endpoint requires an integer port from 1 to 65535")
    }
    return { host, port }
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

async function reserveLoopbackPorts(count) {
    const servers = []
    try {
        for (let index = 0; index < count; index++) {
            const server = net.createServer()
            await listen(server, { host: "127.0.0.1", port: 0 })
            servers.push(server)
        }
        return servers.map(server => server.address().port)
    } finally {
        await Promise.all(servers.map(closeServer))
    }
}

async function waitForPortsReleased(ports, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
        try {
            for (const port of ports) {
                const probe = net.createServer()
                try {
                    await listen(probe, { host: "127.0.0.1", port })
                } finally {
                    if (probe.listening) await closeServer(probe)
                }
            }
            return
        } catch (error) {
            lastError = error
            await delay(50)
        }
    }
    throw lastError ?? new Error("runtime ports were not released")
}

function waitForExit(child, timeoutMs) {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve(true)
            return
        }
        const timer = setTimeout(() => {
            child.off("close", onClose)
            resolve(false)
        }, timeoutMs)
        const onClose = () => {
            clearTimeout(timer)
            resolve(true)
        }
        child.once("close", onClose)
    })
}

class RuntimeProcess {
    constructor(label, child, ports) {
        this.label = label
        this.child = child
        this.ports = ports
        this.stdout = ""
        this.stderr = ""
        this.stopped = false
        child.stdout.on("data", chunk => {
            this.stdout = (this.stdout + chunk).slice(-64_000)
        })
        child.stderr.on("data", chunk => {
            this.stderr = (this.stderr + chunk).slice(-64_000)
        })
    }

    output() {
        return `[${this.label}]\n${this.stdout}\n${this.stderr}`
    }

    async stop() {
        if (this.stopped) return
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill("SIGTERM")
            if (!await waitForExit(this.child, 7_500)) {
                this.child.kill("SIGKILL")
                if (!await waitForExit(this.child, 5_000)) {
                    throw new Error(`process did not stop\n${this.output()}`)
                }
            }
        }
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        await waitForPortsReleased(this.ports)
        this.stopped = true
    }
}

class TcpPeer {
    constructor(label, socket) {
        this.label = label
        this.socket = socket
        this.messages = []
        this.waiters = []
        this.buffer = ""
        this.closed = false
        this.terminalError = null
        this.closedPromise = new Promise(resolve => {
            this.resolveClosed = resolve
        })
        socket.setEncoding("utf8")
        socket.on("data", chunk => this.onData(chunk))
        socket.on("error", error => {
            this.terminate(error)
            if (!socket.destroyed) socket.destroy()
        })
        socket.on("close", () => {
            this.closed = true
            this.terminate(new Error(`${this.label} socket closed`))
            this.resolveClosed()
        })
    }

    onData(chunk) {
        this.buffer += chunk
        while (this.buffer.includes("\0")) {
            const index = this.buffer.indexOf("\0")
            const raw = this.buffer.slice(0, index)
            this.buffer = this.buffer.slice(index + 1)
            if (raw.trim()) this.messages.push(JSON.parse(raw))
        }
        this.flushWaiters()
    }

    flushWaiters() {
        for (const waiter of [...this.waiters]) {
            const index = this.messages.findIndex(waiter.predicate)
            if (index < 0) continue
            this.messages.splice(index, 1)
            this.waiters.splice(this.waiters.indexOf(waiter), 1)
            clearTimeout(waiter.timer)
            waiter.resolve()
        }
    }

    terminate(error) {
        if (this.terminalError) return
        this.terminalError = error
        const waiters = this.waiters.splice(0)
        for (const waiter of waiters) {
            clearTimeout(waiter.timer)
            waiter.reject(error)
        }
    }

    send(message) {
        this.socket.write(`${JSON.stringify(message)}\0`)
    }

    waitFor(predicate, timeoutMs = 5_000) {
        if (this.terminalError) return Promise.reject(this.terminalError)
        const index = this.messages.findIndex(predicate)
        if (index >= 0) {
            this.messages.splice(index, 1)
            return Promise.resolve()
        }
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: null }
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                reject(new Error(`timed out waiting for ${this.label}: ${JSON.stringify(this.messages)}`))
            }, timeoutMs)
            this.waiters.push(waiter)
        })
    }

    close() {
        this.terminate(new Error(`${this.label} socket closed by cleanup`))
        if (!this.closed && !this.socket.destroyed) this.socket.destroy()
        return this.closedPromise
    }
}

class MultiHubProcessHarness {
    constructor(dependencies = {}) {
        const peerCleanupTimeoutMs = dependencies.peerCleanupTimeoutMs
            ?? defaultPeerCleanupTimeoutMs
        const credentialTimeoutMs = dependencies.credentialTimeoutMs
            ?? defaultCredentialTimeoutMs
        const requestTimeoutMs = dependencies.requestTimeoutMs ?? defaultRequestTimeoutMs
        for (const [name, timeoutMs] of [
            ["peerCleanupTimeoutMs", peerCleanupTimeoutMs],
            ["credentialTimeoutMs", credentialTimeoutMs],
            ["requestTimeoutMs", requestTimeoutMs],
        ]) {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
                throw new TypeError(`${name} must be a positive safe integer`)
            }
        }
        this.root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-process-"))
        this.runtimeRoot = path.join(this.root, "runtime")
        this.processes = []
        this.peers = []
        this.pendingSockets = new Set()
        this.lifecycleCleanupTasks = new Set()
        this.lifecycleCleanupErrors = []
        this.cleanupStarted = false
        this.cleanupPromise = null
        this.compiledRuntimeReady = false
        this.buildCompiledRuntime = dependencies.buildCompiledRuntime ?? (options => runCnBuild({
            ...options,
            stdio: ["ignore", process.stderr, process.stderr],
        }))
        this.loadCompiledTableRegistry = dependencies.loadCompiledTableRegistry ?? (() => (
            require(path.join(projectRoot, "out/content/sync/table-registry.js"))
        ))
        this.peerCleanupTimeoutMs = peerCleanupTimeoutMs
        this.credentialTimeoutMs = credentialTimeoutMs
        this.requestTimeoutMs = requestTimeoutMs
        this.spawnSync = dependencies.spawnSync ?? spawnSync
        this.spawnProcess = dependencies.spawnProcess ?? spawn
        this.createConnection = dependencies.createConnection ?? net.createConnection
    }

    dataDir(label) {
        return path.join(this.root, label)
    }

    assertLifecycleActive() {
        if (this.cleanupStarted) throw new Error("harness cleanup has started")
    }

    trackLifecycleCleanup(action, message) {
        const task = settleWithinTimeout(
            action,
            this.peerCleanupTimeoutMs,
            message,
        ).then(result => {
            if (result.status === "rejected") this.lifecycleCleanupErrors.push(result.reason)
        })
        this.lifecycleCleanupTasks.add(task)
        task.then(() => this.lifecycleCleanupTasks.delete(task))
    }

    ensureCompiledRuntime(options = {}) {
        if (this.compiledRuntimeReady) return
        this.assertLifecycleActive()
        const status = this.buildCompiledRuntime(options)
        if (status !== 0) {
            throw new Error(`compiled CN build failed with exit code ${status}`)
        }
        this.assertLifecycleActive()
        this.compiledRuntimeReady = true
    }

    installRuntimeTables(options = {}) {
        this.assertLifecycleActive()
        this.ensureCompiledRuntime(options)
        this.assertLifecycleActive()
        const { TABLE_SOURCES } = this.loadCompiledTableRegistry()
        fs.mkdirSync(this.runtimeRoot, { recursive: true })
        for (const definition of TABLE_SOURCES) {
            const destination = path.join(this.runtimeRoot, definition.tableName)
            fs.mkdirSync(path.dirname(destination), { recursive: true })
            fs.copyFileSync(path.join(projectRoot, definition.bundledPath), destination)
        }
        const catalogRelativePath = "cdn/catalog-cn-1.4.54.json"
        const catalogDestination = path.join(this.runtimeRoot, catalogRelativePath)
        fs.mkdirSync(path.dirname(catalogDestination), { recursive: true })
        fs.copyFileSync(path.join(projectRoot, "assets", catalogRelativePath), catalogDestination)
        const window = {
            availableFromMs: Date.parse("2024-08-14T00:00:00.000Z"),
            availableUntilMs: Date.parse("2024-08-15T00:00:00.000Z"),
        }
        for (const tableName of ["advent_event_quest.json", "challenge_dungeon_event_quest.json"]) {
            const file = path.join(this.runtimeRoot, tableName)
            const table = JSON.parse(fs.readFileSync(file, "utf8"))
            const questId = tableName === "advent_event_quest.json" ? "1001" : "2001"
            table[questId] = { ...table[questId], ...window }
            fs.writeFileSync(file, JSON.stringify(table))
        }
    }

    createCredential(label, { timeoutMs = this.credentialTimeoutMs } = {}) {
        this.assertLifecycleActive()
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new TypeError("credential timeoutMs must be a positive safe integer")
        }
        const dataDir = this.dataDir("host")
        fs.mkdirSync(dataDir, { recursive: true })
        const result = this.spawnSync(
            process.execPath,
            [path.join(projectRoot, "tools/manage_multi_hub_token.cjs"), "create", label],
            {
                cwd: projectRoot,
                encoding: "utf8",
                env: { ...process.env, DATA_DIR: dataDir, MULTI_MODE: "host" },
                timeout: Math.min(this.credentialTimeoutMs, timeoutMs),
            },
        )
        if (result.error?.code === "ETIMEDOUT") {
            throw new Error("credential creation timed out")
        }
        if (result.status !== 0) {
            const status = Number.isInteger(result.status) ? result.status : "unknown"
            throw new Error(`credential creation failed with exit code ${status}`)
        }
        this.assertLifecycleActive()
        try {
            return JSON.parse(result.stdout)
        } catch {
            throw new Error("credential creation returned invalid output")
        }
    }

    spawnRuntime(label, env, ports) {
        this.assertLifecycleActive()
        this.ensureCompiledRuntime()
        this.assertLifecycleActive()
        const runtimeEnv = {
            ...process.env,
            ASSET_MODE: "client-owned",
            CONTENT_RUNTIME_DIR: this.runtimeRoot,
            CN_LISTEN_HOST: "127.0.0.1",
            ...env,
        }
        for (const name of [
            "MULTI_HUB_HOST",
            "MULTI_HUB_PORT",
            "MULTI_HUB_URL",
            "MULTI_HUB_TOKEN",
            "SESSION_HOST",
            "SESSION_PORT",
            "SESSION_PUBLIC_HOST",
        ]) {
            if (!Object.prototype.hasOwnProperty.call(env, name)) delete runtimeEnv[name]
        }
        const child = this.spawnProcess(process.execPath, [path.join(projectRoot, "out/cn-server.js")], {
            cwd: projectRoot,
            env: runtimeEnv,
            stdio: ["ignore", "pipe", "pipe"],
        })
        const runtime = new RuntimeProcess(label, child, ports)
        this.processes.push(runtime)
        if (this.cleanupStarted) {
            this.trackLifecycleCleanup(
                () => runtime.stop(),
                "late runtime cleanup timed out",
            )
            throw new Error("harness cleanup started during runtime spawn")
        }
        return runtime
    }

    async waitForHealth(baseUrl, runtime, timeoutMs = 60_000, signal) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            signal?.throwIfAborted()
            if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
                throw new Error(`server exited before health became available\n${runtime.output()}`)
            }
            try {
                const remainingMs = Math.max(1, deadline - Date.now())
                const response = await fetch(`${baseUrl}/healthz`, {
                    signal: finiteRequestSignal(
                        signal,
                        Math.min(this.requestTimeoutMs, remainingMs),
                    ),
                })
                if (response.status === 200 || response.status === 503) return response.json()
            } catch (error) {
                if (signal?.aborted) signal.throwIfAborted()
                // Listener is not ready yet.
            }
            await delay(50)
        }
        throw new Error(`timed out waiting for health\n${runtime.output()}`)
    }

    async gamePost(baseUrl, route, payload, headers = defaultCompatibilityHeaders, options = {}) {
        const response = await fetch(`${baseUrl}${route}`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                ...headers,
            },
            body: pack(payload).toString("base64"),
            signal: finiteRequestSignal(options.signal, this.requestTimeoutMs),
        })
        const text = await response.text()
        const contentType = response.headers.get("content-type") ?? ""
        let body = text
        if (contentType.startsWith("application/x-msgpack")) {
            body = unpack(Buffer.from(text, "base64"))
        } else if (contentType.startsWith("application/json")) {
            body = JSON.parse(text)
        }
        return { status: response.status, headers: response.headers, body }
    }

    async json(baseUrl, route, init = {}) {
        const response = await fetch(`${baseUrl}${route}`, {
            ...init,
            signal: finiteRequestSignal(init.signal, this.requestTimeoutMs),
        })
        const body = await response.json()
        return { status: response.status, body }
    }

    async openTcp(label, host, port, handshake, timeoutMs = 0) {
        this.assertLifecycleActive()
        const socket = this.createConnection({ host, port })
        this.pendingSockets.add(socket)
        try {
            await new Promise((resolve, reject) => {
                let timer = null
                let settled = false
                const finish = callback => {
                    if (settled) return
                    settled = true
                    if (timer) clearTimeout(timer)
                    socket.off("connect", onConnect)
                    socket.off("error", onError)
                    socket.off("close", onClose)
                    callback()
                }
                const onConnect = () => {
                    finish(resolve)
                }
                const onError = error => {
                    socket.off("connect", onConnect)
                    socket.destroy()
                    finish(() => reject(error))
                }
                const onClose = () => {
                    finish(() => reject(new Error("harness cleanup closed a connecting socket")))
                }
                socket.once("connect", onConnect)
                socket.once("error", onError)
                socket.once("close", onClose)
                if (timeoutMs > 0) {
                    timer = setTimeout(() => {
                        socket.destroy()
                        finish(() => reject(new Error(`${label} TCP connect timed out after ${timeoutMs}ms`)))
                    }, timeoutMs)
                }
            })
        } finally {
            this.pendingSockets.delete(socket)
        }
        if (this.cleanupStarted) {
            if (!socket.destroyed) socket.destroy()
            throw new Error("harness cleanup started during TCP connect")
        }
        const peer = new TcpPeer(label, socket)
        this.peers.push(peer)
        peer.send(handshake)
        return peer
    }

    withDatabase(label, operation, options = {}) {
        const database = new Sqlite(path.join(this.dataDir(label), "wdfp_data.db"), options)
        try {
            return operation(database)
        } finally {
            database.close()
        }
    }

    async cleanup() {
        this.cleanupStarted = true
        if (!this.cleanupPromise) this.cleanupPromise = this.performCleanup()
        return this.cleanupPromise
    }

    async performCleanup() {
        for (const socket of this.pendingSockets) {
            if (!socket.destroyed) socket.destroy()
        }
        const peerResults = await Promise.all(this.peers.map((peer, index) => settleWithinTimeout(
            () => peer.close(),
            this.peerCleanupTimeoutMs,
            `peer cleanup timed out at index ${index}`,
        )))
        const processResults = await Promise.allSettled(
            [...this.processes].reverse().map(runtime => Promise.resolve().then(() => runtime.stop())),
        )
        await Promise.allSettled([...this.lifecycleCleanupTasks])
        let removeFailure
        try {
            fs.rmSync(this.root, { recursive: true, force: true })
        } catch (error) {
            removeFailure = error
        }
        const failures = [...peerResults, ...processResults]
            .filter(result => result.status === "rejected")
            .map(result => result.reason)
        failures.push(...this.lifecycleCleanupErrors)
        if (removeFailure) failures.push(removeFailure)
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "multi-hub process harness cleanup failed",
                { cause: failures[0] },
            )
        }
    }
}

module.exports = {
    MultiHubProcessHarness,
    defaultCompatibilityHeaders,
    preparedTcpEndpoint,
    reserveLoopbackPorts,
}
