"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Sqlite = require("better-sqlite3")
const {
    forceKillProcessTree,
    signalProcessTree,
} = require("./test-workflow/benchmark.cjs")

const projectRoot = path.resolve(__dirname, "..")
const seedBundleFiles = [
    "gacha-seed-catalog/manifest.json",
    "gacha-seed-catalog/normal.json",
    "gacha-seed-catalog/normal_guarantee.json",
    "gacha-seed-catalog/fes.json",
    "gacha-seed-catalog/fes_guarantee.json",
]
const retiredSeedModules = [
    "lib/gacha-physics.js",
    "lib/seed-validator.js",
    "runtime/seed-state-schema.js",
    "runtime/seed-state-store.js",
]

function buildCompiledRuntime() {
    const build = spawnSync(
        process.execPath,
        [path.join(projectRoot, "tools/test-workflow/build-cn.cjs")],
        { cwd: projectRoot, encoding: "utf8" },
    )
    assert.equal(build.status, 0, `build failed\n${build.stdout}\n${build.stderr}`)
}

function assertRetiredSeedModulesAbsent(root, prefix = "out") {
    for (const relativePath of retiredSeedModules) {
        assert.equal(
            fs.existsSync(path.join(root, prefix, relativePath)),
            false,
            `${prefix}/${relativePath} must not be published`,
        )
    }
}

function seedAssetDigests() {
    return Object.fromEntries(seedBundleFiles.map(fileName => [
        fileName,
        crypto.createHash("sha256").update(fs.readFileSync(
            path.join(projectRoot, "assets", fileName),
        )).digest("hex"),
    ]))
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

async function waitForHealth(url, child, output, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`server exited before ready\n${output()}`)
        }
        try {
            const response = await fetch(url)
            if (response.status === 200) return response
        } catch {
            // The HTTP listener is not ready yet.
        }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for health\n${output()}`)
}

function waitForExit(child, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve({ code: child.exitCode, signal: child.signalCode })
            return
        }
        const onClose = (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal })
        }
        const timer = setTimeout(() => {
            child.off("close", onClose)
            reject(new Error("server process did not exit before timeout"))
        }, timeoutMs)
        child.once("close", onClose)
    })
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
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }
    throw lastError ?? new Error("runtime ports were not released before timeout")
}

async function cleanupRuntimeSmoke({ child, dataDir, output, ports, processTree }) {
    let exitResult = child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : null

    if (exitResult === null) {
        try {
            child.kill("SIGTERM")
        } catch (error) {
            if (error.code !== "ESRCH") throw error
        }
        exitResult = await waitForExit(child, 5_000).catch(() => null)
    }
    if (exitResult === null) {
        signalProcessTree(processTree, "SIGTERM")
        exitResult = await waitForExit(child, 2_000).catch(() => null)
    }

    try {
        if (exitResult === null) throw new Error("wrapper did not stop gracefully")
        await waitForPortsReleased(ports)
    } catch {
        try {
            signalProcessTree(processTree, "SIGKILL")
        } finally {
            forceKillProcessTree(processTree)
        }
        exitResult ??= await waitForExit(child, 5_000).catch(() => null)
        if (exitResult === null) throw new Error(`runtime wrapper cleanup failed\n${output()}`)
        await waitForPortsReleased(ports)
    }

    fs.rmSync(dataDir, { recursive: true, force: true })
}

buildCompiledRuntime()

test("[socket] official CN wrapper reports ready and releases resources on SIGTERM", {
    // Node cannot provide reliable POSIX-style child signal semantics on Windows.
    skip: process.platform === "win32" ? "Node signal forwarding smoke is POSIX-only" : false,
    timeout: 90_000,
}, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-runtime-smoke-"))
    const [httpPort, tcpPort] = await reserveLoopbackPorts(2)
    let stdout = ""
    let stderr = ""
    let child = null
    let processTree = null
    const output = () => `${stdout}\n${stderr}`
    t.after(async () => {
        if (child === null || processTree === null) {
            await waitForPortsReleased([httpPort, tcpPort])
            fs.rmSync(dataDir, { recursive: true, force: true })
            return
        }
        await cleanupRuntimeSmoke({
            child,
            dataDir,
            output,
            ports: [httpPort, tcpPort],
            processTree,
        })
    })

    child = spawn(process.execPath, [path.join(projectRoot, "tools/start_cn.cjs")], {
        cwd: projectRoot,
        env: {
            ...process.env,
            ASSET_MODE: "client-owned",
            DATA_DIR: dataDir,
            CN_LISTEN_HOST: "127.0.0.1",
            CN_LISTEN_PORT: String(httpPort),
            SESSION_HOST: "127.0.0.1",
            SESSION_PORT: String(tcpPort),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    })
    processTree = {
        processGroupId: child.pid,
        processId: child.pid,
    }
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32_000) })
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32_000) })

    const response = await waitForHealth(`http://127.0.0.1:${httpPort}/healthz`, child, output)
    assert.match(response.headers.get("content-type"), /^application\/json/)
    const health = await response.json()
    assert.equal(health.status, "ready")
    assert.deepEqual(health.serverBundle, { version: "1.0.1", bundleId: null })
    assert.deepEqual(health.services, { http: true, tcp: true })
        assert.deepEqual(health.database, { ready: true, schema: 20 })
    assert.deepEqual(health.assets, {
        mode: "client-owned",
        status: "unknown",
        minClientVersion: "1.4.54",
        observedClientVersion: null,
    })

    assert.equal(child.kill("SIGTERM"), true)
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null }, output())
    assert.match(output(), /\[runtime\] shutdown complete/)
    assert.match(output(), /\[startup\] CN server exited cleanly/)

    for (const port of [httpPort, tcpPort]) {
        const probe = net.createServer()
        await listen(probe, { host: "127.0.0.1", port })
        await closeServer(probe)
    }

    const database = new Sqlite(path.join(dataDir, "wdfp_data.db"))
    try {
        assert.deepEqual(database.prepare("SELECT 1 AS value").get(), { value: 1 })
        assert.equal(database.pragma("user_version", { simple: true }), 20)
    } finally {
        database.close()
    }
})

test("compiled lifecycle order and metadata fallback survive an isolated bundle", {
    timeout: 60_000,
}, t => {
    assertRetiredSeedModulesAbsent(projectRoot)

    const strictDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-manifest-required-"))
    t.after(() => fs.rmSync(strictDataDir, { recursive: true, force: true }))
    const strictRun = spawnSync(process.execPath, [path.join(projectRoot, "out/cn-server.js")], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 15_000,
        env: {
            ...process.env,
            ASSET_MODE: "client-owned",
            DATA_DIR: strictDataDir,
            EMBEDDED_RUNTIME: "1",
        },
    })
    assert.equal(strictRun.status, 10, `${strictRun.stdout}\n${strictRun.stderr}`)
    assert.match(strictRun.stderr, /\[runtime\] config startup failed/)

    const lifecycleSource = fs.readFileSync(path.join(
        projectRoot,
        "out/runtime/lifecycle.js",
    ), "utf8")
    const databaseIndex = lifecycleSource.indexOf("this.dependencies.initializeDatabase()")
    const contentIndex = lifecycleSource.indexOf("yield this.dependencies.initializeContent(")
    const configureIndex = lifecycleSource.indexOf("this.dependencies.configureHttp(")
    const readyIndex = lifecycleSource.indexOf("yield this.dependencies.readyHttp()")
    assert.ok(databaseIndex >= 0)
    assert.ok(contentIndex >= 0)
    assert.ok(configureIndex >= 0)
    assert.ok(readyIndex >= 0)
    assert.ok(databaseIndex < contentIndex)
    assert.ok(contentIndex < configureIndex)
    assert.ok(configureIndex < readyIndex)

    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-cn-bundle-"))
    t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }))
    const runtimeDir = path.join(bundleRoot, "out", "runtime")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.copyFileSync(
        path.join(projectRoot, "out/runtime/bundle-metadata.js"),
        path.join(runtimeDir, "bundle-metadata.js"),
    )

    const { loadBundleMetadata } = require(path.join(runtimeDir, "bundle-metadata.js"))
    const metadata = loadBundleMetadata({ bundleRoot })
    assert.deepEqual(metadata, { version: "unknown", bundleId: null })

    const { createRuntimeHealthSnapshot } = require(path.join(
        projectRoot,
        "out/runtime/health.js",
    ))
    const health = createRuntimeHealthSnapshot({
        phase: "ready",
        bundleVersion: metadata.version,
        bundleId: metadata.bundleId,
        nodeVersion: process.version,
        database: { ready: true, schema: 4 },
        contentInitialized: true,
        httpListening: true,
        multi: {
            mode: "embedded",
            state: "ready",
            coordinator: { kind: "local", available: true },
            hub: null,
            tcp: { available: true, endpoint: "127.0.0.1:8003" },
        },
        adminAvailable: true,
        assetMode: "client-owned",
    })
    assert.equal(health.statusCode, 200)
    assert.equal(health.body.serverBundle.version, "unknown")
    assert.deepEqual(health.body.admin, { required: true, available: true })

    const seedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "compiled-seed-state-"))
    t.after(() => fs.rmSync(seedDataDir, { recursive: true, force: true }))
    const previousDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = seedDataDir
    t.after(() => {
        if (previousDataDir === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDir
    })
    const beforeSeedAssets = seedAssetDigests()
    const { GachaSeedQuarantine } = require(path.join(
        projectRoot,
        "out/lib/gacha-seed-quarantine.js",
    ))

    const seedStateDir = path.join(seedDataDir, "state", "seeds")
    const quarantine = new GachaSeedQuarantine({
        stateFile: path.join(seedStateDir, "quarantine.json"),
    })
    quarantine.markSent("fes", 214748301, 5)
    assert.equal(quarantine.quarantineIfRecentlySent("fes", 214748301), true)

    assert.deepEqual(fs.readdirSync(seedStateDir), ["quarantine.json"])
    const persistedSeedState = JSON.parse(fs.readFileSync(
        path.join(seedStateDir, "quarantine.json"),
        "utf8",
    ))
    assert.equal(persistedSeedState.schemaVersion, 1)
    assert.deepEqual(persistedSeedState.movies, { fes: [214748301] })
    assert.deepEqual(seedAssetDigests(), beforeSeedAssets)
})

test("verified Server Bundle publishes its manifest identity through health", {
    timeout: 90_000,
}, async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-bundle-smoke-"))
    const bundleRoot = path.join(sandbox, "bundle")
    const dataDir = path.join(sandbox, "data")
    const { buildServerBundle } = require("./server-bundle/build.cjs")
    const { verifyServerBundle } = require("./server-bundle/verify.cjs")
    const manifest = buildServerBundle({ projectRoot, outputRoot: bundleRoot })
    assertRetiredSeedModulesAbsent(bundleRoot)
    assert.deepEqual(verifyServerBundle({
        bundleRoot,
        dataSchema: 5,
        dependencyLock: manifest.requires.dependencyLock,
    }), manifest)

    const [httpPort, tcpPort] = await reserveLoopbackPorts(2)
    let stdout = ""
    let stderr = ""
    let child = null
    let processTree = null
    const output = () => `${stdout}\n${stderr}`
    t.after(async () => {
        if (child !== null && processTree !== null) {
            await cleanupRuntimeSmoke({
                child,
                dataDir: sandbox,
                output,
                ports: [httpPort, tcpPort],
                processTree,
            })
        } else {
            fs.rmSync(sandbox, { recursive: true, force: true })
        }
    })

    child = spawn(process.execPath, [path.join(bundleRoot, manifest.entry)], {
        cwd: bundleRoot,
        env: {
            ...process.env,
            ASSET_MODE: "client-owned",
            DATA_DIR: dataDir,
            EMBEDDED_RUNTIME: "1",
            NODE_PATH: path.join(projectRoot, "node_modules"),
            CN_LISTEN_HOST: "127.0.0.1",
            CN_LISTEN_PORT: String(httpPort),
            SESSION_HOST: "127.0.0.1",
            SESSION_PORT: String(tcpPort),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    })
    processTree = { processGroupId: child.pid, processId: child.pid }
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32_000) })
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32_000) })

    const response = await waitForHealth(`http://127.0.0.1:${httpPort}/healthz`, child, output)
    const health = await response.json()
    assert.deepEqual(health.serverBundle, {
        version: manifest.serverVersion,
        bundleId: manifest.bundleId,
    })

    assert.equal(child.kill("SIGTERM"), true)
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null }, output())
})
