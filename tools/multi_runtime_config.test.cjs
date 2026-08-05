"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const { parseCnRuntimeConfig } = require("../src/runtime/config")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")

test("multiplayer defaults to the current embedded listener", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: { ASSET_MODE: "client-owned" },
    })

    assert.deepEqual(config.multi, {
        mode: "embedded",
        tcp: { host: "127.0.0.1", port: 8003 },
    })
    assert.equal(Object.isFrozen(config.multi), true)
    assert.equal(Object.isFrozen(config.multi.tcp), true)
})

test("host mode requires public TCP reachability and keeps credentials private", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-config-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const dataDir = path.join(sandbox, "data")
    fs.mkdirSync(dataDir)

    const config = parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            DATA_DIR: dataDir,
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "0.0.0.0",
            MULTI_HUB_PORT: "8004",
            SESSION_HOST: "0.0.0.0",
            SESSION_PORT: "8003",
            SESSION_PUBLIC_HOST: "192.0.2.20",
        },
    })

    assert.deepEqual(config.multi, {
        mode: "host",
        tcp: { host: "0.0.0.0", port: 8003, publicHost: "192.0.2.20" },
        hub: { host: "0.0.0.0", port: 8004 },
        credentialsPath: path.join(fs.realpathSync(dataDir), "multi-hub-credentials.json"),
    })
    assert.equal(path.isAbsolute(config.multi.credentialsPath), true)
    assert.equal(fs.existsSync(config.multi.credentialsPath), false)

    assert.throws(() => parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            DATA_DIR: dataDir,
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "0.0.0.0",
            MULTI_HUB_PORT: "8004",
        },
    }))
})

test("host accepts an explicit absolute credentials path outside tracked content", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-credentials-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const dataDir = path.join(sandbox, "data")
    const credentialsPath = path.join(sandbox, "private", "credentials.json")
    fs.mkdirSync(dataDir)

    const config = parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            DATA_DIR: dataDir,
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "127.0.0.1",
            MULTI_HUB_PORT: "8004",
            SESSION_PUBLIC_HOST: "hub.internal",
            MULTI_HUB_CREDENTIALS_FILE: credentialsPath,
        },
    })

    assert.equal(
        config.multi.credentialsPath,
        path.join(fs.realpathSync(sandbox), "private", "credentials.json"),
    )
    for (const invalidPath of [
        "relative/credentials.json",
        path.join(projectRoot, "src", "multi-hub-credentials.json"),
    ]) {
        assert.throws(() => parseCnRuntimeConfig({
            projectRoot,
            env: {
                ASSET_MODE: "client-owned",
                DATA_DIR: dataDir,
                MULTI_MODE: "host",
                MULTI_HUB_HOST: "127.0.0.1",
                MULTI_HUB_PORT: "8004",
                SESSION_PUBLIC_HOST: "hub.internal",
                MULTI_HUB_CREDENTIALS_FILE: invalidPath,
            },
        }))
    }
})

test("host defaults to the private runtime data area and rejects tracked DATA_DIR content", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "127.0.0.1",
            MULTI_HUB_PORT: "8004",
            SESSION_PUBLIC_HOST: "hub.internal",
        },
    })

    assert.equal(
        config.multi.credentialsPath,
        path.join(fs.realpathSync(projectRoot), ".database", "multi-hub-credentials.json"),
    )
    assert.throws(() => parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            DATA_DIR: path.join(projectRoot, "src"),
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "127.0.0.1",
            MULTI_HUB_PORT: "8004",
            SESSION_PUBLIC_HOST: "hub.internal",
        },
    }))
})

test("host rejects a private data symlink that resolves into tracked project content", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-symlink-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const temporaryProjectRoot = path.join(sandbox, "repo")
    const trackedDir = path.join(temporaryProjectRoot, "tracked")
    fs.mkdirSync(trackedDir, { recursive: true })
    fs.symlinkSync(trackedDir, path.join(temporaryProjectRoot, ".database"), "dir")

    assert.throws(() => parseCnRuntimeConfig({
        projectRoot: temporaryProjectRoot,
        env: {
            ASSET_MODE: "client-owned",
            MULTI_MODE: "host",
            MULTI_HUB_HOST: "127.0.0.1",
            MULTI_HUB_PORT: "8004",
            SESSION_PUBLIC_HOST: "hub.internal",
        },
    }), error => error?.code === "INVALID_RUNTIME_CONFIG")
})

test("client mode accepts only an issued remote Hub credential and has no local TCP listener", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            MULTI_MODE: "client",
            MULTI_HUB_URL: "http://192.0.2.20:8004",
            MULTI_HUB_TOKEN: "a".repeat(32),
        },
    })

    assert.equal(config.multi.mode, "client")
    assert.equal(config.multi.hubUrl.href, "http://192.0.2.20:8004/")
    assert.equal(config.multi.token, "a".repeat(32))
    assert.equal("tcp" in config.multi, false)

    for (const env of [
        { MULTI_MODE: "client", MULTI_HUB_TOKEN: "a".repeat(32) },
        { MULTI_MODE: "client", MULTI_HUB_URL: "http://192.0.2.20:8004" },
        { MULTI_MODE: "client", MULTI_HUB_URL: "http://192.0.2.20:8004", MULTI_HUB_TOKEN: "123" },
        {
            MULTI_MODE: "client",
            MULTI_HUB_URL: "http://192.0.2.20:8004",
            MULTI_HUB_TOKEN: "a".repeat(32),
            SESSION_HOST: "127.0.0.1",
        },
    ]) {
        assert.throws(() => parseCnRuntimeConfig({
            projectRoot,
            env: { ASSET_MODE: "client-owned", ...env },
        }))
    }
})

test("multiplayer rejects unknown modes", () => {
    assert.throws(() => parseCnRuntimeConfig({
        projectRoot,
        env: { ASSET_MODE: "client-owned", MULTI_MODE: "public" },
    }))
})

function createServiceHarness() {
    const calls = []
    let tcpListening = false
    let hubListening = false
    let failTcp = false
    let failHub = false
    const service = createMultiRuntimeService({
        async startTcp(config) {
            calls.push(["tcp-start", config])
            if (failTcp) throw Object.assign(new Error("bind failed"), { code: "EADDRINUSE" })
            tcpListening = true
        },
        async stopTcp() {
            calls.push("tcp-stop")
            tcpListening = false
        },
        isTcpListening: () => tcpListening,
        async startHub(config) {
            calls.push(["hub-start", config])
            if (failHub) throw Object.assign(new Error("bind failed"), { code: "EADDRINUSE" })
            hubListening = true
        },
        async stopHub() {
            calls.push("hub-stop")
            hubListening = false
        },
        isHubListening: () => hubListening,
    })
    return {
        calls,
        service,
        failTcp() { failTcp = true },
        failHub() { failHub = true },
    }
}

test("embedded runtime service preserves the local coordinator and TCP experience", async () => {
    const harness = createServiceHarness()
    await harness.service.start({
        mode: "embedded",
        tcp: { host: "127.0.0.1", port: 8003 },
    })

    assert.deepEqual(harness.calls, [
        ["tcp-start", { host: "127.0.0.1", port: 8003 }],
    ])
    assert.deepEqual(harness.service.getStatus(), {
        mode: "embedded",
        state: "ready",
        coordinator: { kind: "local", available: true },
        hub: null,
        tcp: { available: true, endpoint: "127.0.0.1:8003" },
    })
    assert.equal(typeof harness.service.getHttpContext().coordinator.createRoom, "function")

    await harness.service.stop()
    assert.deepEqual(harness.calls.at(-1), "tcp-stop")
})

test("host Hub bind failure degrades multiplayer without discarding local TCP", async () => {
    const harness = createServiceHarness()
    harness.failHub()
    await harness.service.start({
        mode: "host",
        tcp: { host: "0.0.0.0", port: 8003, publicHost: "192.0.2.20" },
        hub: { host: "0.0.0.0", port: 8004 },
        credentialsPath: path.join(os.tmpdir(), "unused-multi-credentials.json"),
    })

    assert.deepEqual(harness.service.getStatus(), {
        mode: "host",
        state: "degraded",
        coordinator: { kind: "local", available: true },
        hub: { available: false, endpoint: "http://0.0.0.0:8004" },
        tcp: { available: true, endpoint: "192.0.2.20:8003" },
    })
    await harness.service.stop()
    assert.equal(harness.calls.includes("tcp-stop"), true)
})

test("host TCP bind failure keeps the control listener available and degrades multiplayer", async () => {
    const harness = createServiceHarness()
    harness.failTcp()
    await harness.service.start({
        mode: "host",
        tcp: { host: "0.0.0.0", port: 8003, publicHost: "192.0.2.20" },
        hub: { host: "127.0.0.1", port: 8004 },
        credentialsPath: path.join(os.tmpdir(), "unused-multi-credentials.json"),
    })

    assert.deepEqual(harness.service.getStatus(), {
        mode: "host",
        state: "degraded",
        coordinator: { kind: "local", available: true },
        hub: { available: true, endpoint: "http://127.0.0.1:8004" },
        tcp: { available: false, endpoint: "192.0.2.20:8003" },
    })
    await harness.service.stop()
})

test("client runtime is an explicit remote placeholder and never starts local listeners", async () => {
    const harness = createServiceHarness()
    await harness.service.start({
        mode: "client",
        hubUrl: new URL("http://192.0.2.20:8004"),
        token: "a".repeat(32),
    })

    assert.deepEqual(harness.calls, [])
    assert.deepEqual(harness.service.getStatus(), {
        mode: "client",
        state: "degraded",
        coordinator: { kind: "remote", available: false },
        hub: { available: false, endpoint: "http://192.0.2.20:8004/" },
        tcp: { available: false, endpoint: null },
    })
    const result = await harness.service.getHttpContext().coordinator.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 1 },
        roomNumber: "123456",
    })
    assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
    await harness.service.stop()
    assert.deepEqual(harness.calls, [])
})

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve()
        })
    })
}

async function availablePort() {
    const server = net.createServer()
    await listen(server)
    const address = server.address()
    assert.ok(address && typeof address === "object")
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
    })
    return address.port
}

function getStatus(port, requestPath) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port, path: requestPath }, response => {
            response.resume()
            response.once("end", () => resolve(response.statusCode))
        })
        request.once("error", reject)
    })
}

test("real host starts without credentials and leaves registration unimplemented", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-empty-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "credentials.json")
    const tcpPort = await availablePort()
    const hubPort = await availablePort()
    const service = createMultiRuntimeService()
    t.after(() => service.stop())

    await service.start({
        mode: "host",
        tcp: { host: "127.0.0.1", port: tcpPort, publicHost: "127.0.0.1" },
        hub: { host: "127.0.0.1", port: hubPort },
        credentialsPath,
    })

    assert.equal(fs.existsSync(credentialsPath), false)
    assert.equal(service.getStatus().state, "ready")
    assert.equal(await getStatus(hubPort, "/register"), 404)
})
