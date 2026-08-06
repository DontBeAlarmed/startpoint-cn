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
const { RemoteMultiCoordinator } = require("../src/multi/coordinator/remote")
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")

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

function createServiceHarness(options = {}) {
    const calls = []
    let tcpListening = false
    let hubListening = false
    let failTcp = false
    let failHub = false
    let hostServices = null
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
        async startHub(config, _onFatalError, services) {
            calls.push(["hub-start", config])
            if (failHub) throw Object.assign(new Error("bind failed"), { code: "EADDRINUSE" })
            hostServices = services
            hubListening = true
        },
        async stopHub() {
            calls.push("hub-stop")
            hubListening = false
        },
        isHubListening: () => hubListening,
        createRemoteCoordinator: options.createRemoteCoordinator,
    })
    return {
        calls,
        service,
        failTcp() { failTcp = true },
        failHub() { failHub = true },
        hostServices() { return hostServices },
    }
}

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

function hostRuntimeConfig(label = "hub.internal") {
    return {
        mode: "host",
        tcp: { host: "127.0.0.1", port: 8003, publicHost: label },
        hub: { host: "127.0.0.1", port: 8004 },
        credentialsPath: path.join(os.tmpdir(), `unused-${label}-credentials.json`),
    }
}

test("stop during TCP start prevents a late Host control listener", async () => {
    const tcpStarted = deferred()
    const calls = []
    let tcpListening = false
    let hubListening = false
    const service = createMultiRuntimeService({
        async startTcp() {
            calls.push("tcp-start")
            await tcpStarted.promise
            tcpListening = true
        },
        async stopTcp() { calls.push("tcp-stop"); tcpListening = false },
        isTcpListening: () => tcpListening,
        async startHub() { calls.push("hub-start"); hubListening = true },
        async stopHub() { calls.push("hub-stop"); hubListening = false },
        isHubListening: () => hubListening,
    })

    const starting = service.start(hostRuntimeConfig())
    await new Promise(resolve => setImmediate(resolve))
    const stopping = service.stop()
    tcpStarted.resolve()
    await Promise.all([starting, stopping])

    assert.deepEqual(calls, ["tcp-start", "tcp-stop"])
    assert.equal(tcpListening, false)
    assert.equal(hubListening, false)
    assert.equal(service.getStatus().state, "unavailable")
})

test("stop during Hub start closes the late control listener", async () => {
    const hubStarted = deferred()
    const calls = []
    let tcpListening = false
    let hubListening = false
    const service = createMultiRuntimeService({
        async startTcp() { calls.push("tcp-start"); tcpListening = true },
        async stopTcp() { calls.push("tcp-stop"); tcpListening = false },
        isTcpListening: () => tcpListening,
        async startHub() {
            calls.push("hub-start")
            await hubStarted.promise
            hubListening = true
        },
        async stopHub() { calls.push("hub-stop"); hubListening = false },
        isHubListening: () => hubListening,
    })

    const starting = service.start(hostRuntimeConfig())
    while (!calls.includes("hub-start")) await new Promise(resolve => setImmediate(resolve))
    const stopping = service.stop()
    hubStarted.resolve()
    await Promise.all([starting, stopping])

    assert.deepEqual(calls, ["tcp-start", "hub-start", "hub-stop", "tcp-stop"])
    assert.equal(tcpListening, false)
    assert.equal(hubListening, false)
    assert.equal(service.getStatus().state, "unavailable")
})

test("an old generation completes before a queued Host start becomes current", async () => {
    const firstTcpStarted = deferred()
    const calls = []
    let tcpStarts = 0
    let tcpListening = false
    let hubListening = false
    const service = createMultiRuntimeService({
        async startTcp(config) {
            calls.push(["tcp-start", config.publicHost])
            tcpStarts += 1
            if (tcpStarts === 1) await firstTcpStarted.promise
            tcpListening = true
        },
        async stopTcp() { calls.push("tcp-stop"); tcpListening = false },
        isTcpListening: () => tcpListening,
        async startHub() { calls.push("hub-start"); hubListening = true },
        async stopHub() { calls.push("hub-stop"); hubListening = false },
        isHubListening: () => hubListening,
    })

    const oldStart = service.start(hostRuntimeConfig("old.internal"))
    await new Promise(resolve => setImmediate(resolve))
    const stopping = service.stop()
    const newStart = service.start(hostRuntimeConfig("new.internal"))
    firstTcpStarted.resolve()
    await Promise.all([oldStart, stopping, newStart])

    assert.deepEqual(calls, [
        ["tcp-start", "old.internal"],
        "tcp-stop",
        ["tcp-start", "new.internal"],
        "hub-start",
    ])
    assert.equal(service.getStatus().tcp.endpoint, "new.internal:8003")
    assert.equal(service.getStatus().state, "ready")
    await service.stop()
})

for (const component of ["hub", "tcp"]) {
    test(`${component} stop failure remains retryable and concurrent stop is shared`, async () => {
        const calls = []
        let tcpListening = false
        let hubListening = false
        let tcpStops = 0
        let hubStops = 0
        const service = createMultiRuntimeService({
            async startTcp() { tcpListening = true },
            async stopTcp() {
                calls.push("tcp-stop")
                tcpStops += 1
                if (component === "tcp" && tcpStops === 1) {
                    throw Object.assign(new Error("TCP close failed"), { code: "EIO" })
                }
                tcpListening = false
            },
            isTcpListening: () => tcpListening,
            async startHub() { hubListening = true },
            async stopHub() {
                calls.push("hub-stop")
                hubStops += 1
                if (component === "hub" && hubStops === 1) {
                    throw Object.assign(new Error("Hub close failed"), { code: "EIO" })
                }
                hubListening = false
            },
            isHubListening: () => hubListening,
        })
        await service.start(hostRuntimeConfig())

        const firstStop = service.stop()
        const concurrentStop = service.stop()
        const sharedStop = concurrentStop === firstStop
        const stopResults = await Promise.allSettled([firstStop, concurrentStop])
        assert.equal(sharedStop, true)
        assert.equal(stopResults[0].status, "rejected")
        assert.equal(stopResults[0].reason.code, "EIO")
        assert.equal(stopResults[1].status, "rejected")
        assert.equal(component === "hub" ? hubListening : tcpListening, true)

        await service.stop()
        assert.equal(tcpListening, false)
        assert.equal(hubListening, false)
        assert.equal(component === "hub" ? hubStops : tcpStops, 2)
        assert.equal(service.getStatus().state, "unavailable")
        assert.throws(() => service.getHttpContext())
    })
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
    assert.equal(harness.hostServices().getTcpEndpoint(), null)
    await harness.service.stop()
})

test("client runtime installs routed remote authority and starts local fallback only on demand", async () => {
    const remote = new RemoteMultiCoordinator({
        read: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
        write: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
        getTcpEndpoint: () => null,
        getNodeSessionId: () => null,
        isAvailable: () => false,
    })
    const harness = createServiceHarness({ createRemoteCoordinator: () => remote })
    await harness.service.start({
        mode: "client",
        hubUrl: new URL("http://192.0.2.20:8004"),
        token: "a".repeat(32),
    })

    assert.deepEqual(harness.calls, [])
    assert.notEqual(harness.service.getHttpContext().coordinator, remote)
    assert.equal(typeof harness.service.getHttpContext().resolveCoordinatorOrigin, "function")
    assert.deepEqual(harness.service.getStatus(), {
        mode: "client",
        state: "degraded",
        clientFallbackState: "remote",
        coordinator: { kind: "remote", available: false },
        hub: { available: false, endpoint: "http://192.0.2.20:8004/" },
        tcp: { available: false, endpoint: null },
    })
    const result = await harness.service.getHttpContext().coordinator.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 1 },
        roomNumber: "123456",
    })
    assert.deepEqual(result, { ok: false, error: "ROOM_NOT_FOUND" })
    assert.deepEqual(harness.calls, [["tcp-start", { host: "127.0.0.1", port: 8003 }]])
    await harness.service.stop()
    assert.deepEqual(harness.calls, [
        ["tcp-start", { host: "127.0.0.1", port: 8003 }],
        "tcp-stop",
    ])
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

function postJson(port, requestPath, headers, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
        const request = http.request({
            host: "127.0.0.1",
            port,
            path: requestPath,
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                ...headers,
            },
        }, response => {
            let responseBody = ""
            response.setEncoding("utf8")
            response.on("data", chunk => { responseBody += chunk })
            response.once("end", () => resolve({
                statusCode: response.statusCode,
                body: JSON.parse(responseBody),
            }))
        })
        request.once("error", reject)
        request.end(body)
    })
}

async function waitFor(predicate, message, timeoutMs) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        if (await predicate()) return
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail(message)
}

function connectSession(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port })
        const connection = { socket, frames: [], closed: false }
        let buffer = ""
        let connected = false
        socket.setEncoding("utf8")
        socket.on("data", chunk => {
            buffer += chunk
            while (buffer.includes("\0")) {
                const index = buffer.indexOf("\0")
                const raw = buffer.slice(0, index)
                buffer = buffer.slice(index + 1)
                if (raw.length > 0) connection.frames.push(JSON.parse(raw))
            }
        })
        socket.on("close", () => { connection.closed = true })
        socket.on("error", error => {
            if (!connected) reject(error)
        })
        socket.on("connect", () => {
            connected = true
            resolve(connection)
        })
    })
}

function sendSessionFrame(connection, frame) {
    connection.socket.write(`${JSON.stringify(frame)}\0`)
}

function frameCount(connection, frame) {
    const encoded = JSON.stringify(frame)
    return connection.frames.filter(candidate => JSON.stringify(candidate) === encoded).length
}

function admissionSnapshot(viewerId) {
    return Object.freeze({
        viewerId,
        name: `HostPlayer${viewerId}`,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 101,
        playerRoleKind: 1,
        isNewbie: false,
        currentPartyId: 1,
        party: {
            characters: [[1], [1], [1]],
            unison_characters: [[1], [1], [1]],
            equipments: [[1], [1], [1]],
            abilitySoulIds: [[1], [1], [1]],
        },
        npcParties: [],
    })
}

test("host TCP accepts only its explicit internal identity across credential revocation", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-internal-identity-"))
    const credentialsPath = path.join(root, "credentials.json")
    const store = new MultiHubCredentialStore({ credentialsPath })
    const issued = store.create("remote-node")
    const tcpPort = await availablePort()
    const hubPort = await availablePort()
    const service = createMultiRuntimeService()
    const connections = []
    let roomNumber
    t.after(async () => {
        for (const connection of connections) connection.socket.destroy()
        await service.stop()
        if (roomNumber) require("../src/multi/room/manager").disbandRoom(roomNumber)
        fs.rmSync(root, { recursive: true, force: true })
    })

    await service.start({
        mode: "host",
        tcp: { host: "127.0.0.1", port: tcpPort, publicHost: "127.0.0.1" },
        hub: { host: "127.0.0.1", port: hubPort },
        credentialsPath,
    })
    let registration
    await waitFor(async () => {
        registration = await postJson(hubPort, "/v1/multi/nodes/register", {
            authorization: `Bearer ${issued.token}`,
        }, { protocolVersion: 1 })
        return registration.statusCode === 200
    }, "host credential was not loaded", 2_000)

    const context = service.getHttpContext()
    const internalParticipant = context.snapshotProvider.getParticipant(901)
    assert.deepEqual(internalParticipant, { nodeSessionId: "embedded", viewerId: 901 })
    const compatibility = {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "20240814",
        cdnTargetVersion: "cn-20240814",
        contentDigest: `sha256:${"c".repeat(64)}`,
        modeDigest: `sha256:${"d".repeat(64)}`,
    }
    const created = await context.coordinator.createRoom({
        requestId: "host-internal-room",
        participant: internalParticipant,
        localPlayerId: 901,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    roomNumber = created.value.roomNumber
    const issueAdmission = participant => context.admissionIssuer.issue({
        roomNumber,
        participant,
        snapshot: admissionSnapshot(participant.viewerId),
        expiresAt: Date.now() + 5_000,
    })
    const openRoomSocket = async (participant, connectionId) => {
        issueAdmission(participant)
        const connection = await connectSession(tcpPort)
        connections.push(connection)
        sendSessionFrame(connection, {
            socklet: "cooperation_room",
            viewerId: participant.viewerId,
            roomNumber,
            questCategory: 1,
            questId: 501,
            connectionId,
        })
        return connection
    }

    const internal = await openRoomSocket(internalParticipant, "host-internal-cid")
    await waitFor(
        () => frameCount(internal, [0, "host-internal-cid", roomNumber]) === 1,
        "Host internal handshake was not accepted",
        2_000,
    )
    sendSessionFrame(internal, [0, [4]])
    await waitFor(
        () => frameCount(internal, [1, [11, "host-internal-cid"]]) === 1,
        "Host internal inbound frame was rejected",
        2_000,
    )
    assert.equal(internal.closed, false)

    const forged = await openRoomSocket(
        { nodeSessionId: "embedded-forged", viewerId: 902 },
        "forged-internal-cid",
    )
    await waitFor(() => forged.closed, "forged embedded-like identity stayed connected", 2_000)

    store.revoke(issued.credentialId)
    await waitFor(async () => {
        const rejected = await postJson(hubPort, "/v1/multi/nodes/register", {
            authorization: `Bearer ${issued.token}`,
        }, { protocolVersion: 1 })
        return rejected.statusCode === 401
    }, "credential revocation was not loaded", 2_000)

    const beforeRevocationHeartbeat = frameCount(internal, [1, [11, "host-internal-cid"]])
    sendSessionFrame(internal, [0, [4]])
    await waitFor(
        () => frameCount(internal, [1, [11, "host-internal-cid"]]) === beforeRevocationHeartbeat + 1,
        "credential revocation invalidated the Host internal identity",
        2_000,
    )
    assert.equal(internal.closed, false)

    const revokedRemote = await openRoomSocket({
        nodeSessionId: registration.body.nodeSessionId,
        viewerId: 903,
    }, "revoked-remote-cid")
    await waitFor(() => revokedRemote.closed, "revoked remote identity stayed connected", 2_000)
})

test("real host hot-loads credentials and serves only the trusted control API", async t => {
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
    const missing = await postJson(hubPort, "/v1/multi/nodes/register", {
        authorization: `Bearer ${"a".repeat(64)}`,
    }, { protocolVersion: 1 })
    assert.equal(missing.statusCode, 401)

    const store = new MultiHubCredentialStore({ credentialsPath })
    const issued = store.create("runtime-node-a")
    const peer = store.create("runtime-node-b")
    let registration
    let peerRegistration
    await waitFor(async () => {
        registration = await postJson(hubPort, "/v1/multi/nodes/register", {
            authorization: `Bearer ${issued.token}`,
        }, { protocolVersion: 1 })
        peerRegistration = await postJson(hubPort, "/v1/multi/nodes/register", {
            authorization: `Bearer ${peer.token}`,
        }, { protocolVersion: 1 })
        return registration.statusCode === 200 && peerRegistration.statusCode === 200
    }, "credential table was not hot-loaded", 2_000)
    assert.match(registration.body.nodeSessionId, /^[A-Za-z0-9_-]+$/)
    assert.match(registration.body.sessionCredential, /^[A-Za-z0-9_-]{43}$/)

    const compatibility = {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "20240814",
        cdnTargetVersion: "cn-20240814",
        contentDigest: `sha256:${"a".repeat(64)}`,
        modeDigest: `sha256:${"b".repeat(64)}`,
    }
    const sessionHeaders = node => ({
        authorization: `Bearer ${node.body.sessionCredential}`,
        "x-node-session-id": node.body.nodeSessionId,
    })
    const createRoom = (node, viewerId, key) => postJson(
        hubPort,
        "/v1/multi/rooms/create",
        { ...sessionHeaders(node), "x-idempotency-key": key },
        {
            requestId: key,
            participant: { nodeSessionId: node.body.nodeSessionId, viewerId },
            partyId: 1,
            category: 1,
            questId: 501,
            leaderCharacterId: 101,
            compatibility,
        },
    )
    const firstRoom = await createRoom(registration, 601, "runtime-room-a")
    const secondRoom = await createRoom(peerRegistration, 602, "runtime-room-b")
    assert.equal(firstRoom.statusCode, 200)
    assert.equal(secondRoom.statusCode, 200)

    store.revoke(issued.credentialId)
    await waitFor(async () => {
        const invalid = await postJson(
            hubPort,
            "/v1/multi/rooms/status",
            sessionHeaders(registration),
            {
                participant: { nodeSessionId: registration.body.nodeSessionId, viewerId: 601 },
                roomNumber: firstRoom.body.value.roomNumber,
            },
        )
        return invalid.statusCode === 401
    }, "revoked runtime node session stayed valid", 2_000)

    const removed = await postJson(
        hubPort,
        "/v1/multi/rooms/status",
        sessionHeaders(peerRegistration),
        {
            participant: { nodeSessionId: peerRegistration.body.nodeSessionId, viewerId: 602 },
            roomNumber: firstRoom.body.value.roomNumber,
        },
    )
    const retained = await postJson(
        hubPort,
        "/v1/multi/rooms/status",
        sessionHeaders(peerRegistration),
        {
            participant: { nodeSessionId: peerRegistration.body.nodeSessionId, viewerId: 602 },
            roomNumber: secondRoom.body.value.roomNumber,
        },
    )
    assert.deepEqual(removed.body, { ok: false, code: "ROOM_NOT_FOUND" })
    assert.equal(retained.body.ok, true)
    assert.equal(await getStatus(hubPort, "/api/player"), 404)
    assert.equal(await getStatus(hubPort, "/"), 404)
})
