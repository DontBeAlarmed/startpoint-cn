"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")

require("ts-node/register/transpile-only")

let adminStatus = {}
try {
    adminStatus = require("../src/lib/admin-multi-status")
} catch {
    // RED: the read-only multiplayer diagnostic boundary is introduced here.
}

const {
    CompatibilityRejectionStore,
    buildAdminMultiStatus,
} = adminStatus

const repositoryRoot = path.resolve(__dirname, "..")
const privateHomePrefix = path.join(path.sep, "Users") + path.sep
const privateHomePath = path.join(privateHomePrefix, "example", "private.json")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { createCompatibilityProfileFactory } = require("../src/multi/compatibility")
const { disbandRoom } = require("../src/multi/room/manager")
const serverRoutes = require("../src/routes/web_api/server").default
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
productionContentSnapshotProvider.snapshot = {
    ...productionContentSnapshotProvider.snapshot,
    cdn: {
        ...productionContentSnapshotProvider.snapshot.cdn,
        fullBaseVersion: "1.4.0",
        edges: [],
    },
    archiveSources: { schemaVersion: 1, archives: [] },
}

test.after(() => restoreContentSnapshot())

function runtime(mode, overrides = {}) {
    const remote = mode === "client"
    return {
        mode,
        state: "ready",
        coordinator: { kind: remote ? "remote" : "local", available: true },
        hub: mode === "embedded"
            ? null
            : { available: true, endpoint: remote ? "https://hub.example/" : "http://127.0.0.1:8004" },
        tcp: { available: true, endpoint: remote ? "hub.example:8003" : "127.0.0.1:8003" },
        ...overrides,
    }
}

test("admin status has one stable read-only shape for every runtime mode", () => {
    assert.equal(typeof buildAdminMultiStatus, "function")
    for (const mode of ["embedded", "host", "client"]) {
        const result = buildAdminMultiStatus({
            runtime: runtime(mode),
            authority: {
                activeRooms: 2,
                activeBattleFacts: 3,
                finalizedBattleFacts: 4,
            },
            latestCompatibilityRejection: null,
        })
        assert.deepEqual(Object.keys(result), [
            "mode",
            "state",
            "coordinator",
            "hub",
            "tcp",
            "activeRooms",
            "battleFacts",
            "latestCompatibilityRejection",
        ])
        assert.equal(result.mode, mode)
        assert.equal(result.activeRooms, 2)
        assert.deepEqual(result.battleFacts, { active: 3, finalized: 4 })
    }
})

test("unavailable and degraded diagnostics never invent authoritative counts", () => {
    for (const [state, mode] of [["unavailable", "embedded"], ["degraded", "client"]]) {
        const result = buildAdminMultiStatus({
            runtime: runtime(mode, {
                state,
                coordinator: { kind: mode === "client" ? "remote" : "local", available: false },
                hub: mode === "client" ? { available: false, endpoint: "https://hub.example/" } : null,
                tcp: { available: false, endpoint: null },
            }),
            authority: null,
            latestCompatibilityRejection: null,
        })
        assert.equal(result.state, state)
        assert.equal(result.activeRooms, null)
        assert.equal(result.battleFacts, null)
    }
})

test("diagnostics strip forbidden keys, absolute paths, credentials, and identities", () => {
    const result = buildAdminMultiStatus({
        runtime: runtime("client"),
        authority: {
            activeRooms: 1,
            activeBattleFacts: 1,
            finalizedBattleFacts: 0,
            token: "top-secret",
            sessionCredential: "session-secret",
            credentialId: "credential-123",
            viewerId: 101,
            playerId: 9,
            deviceId: 8,
            path: privateHomePath,
            rawBody: { secret: true },
            stack: "private stack",
        },
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM",
            differences: [{
                field: "RES_VER",
                required: "1.4.54",
                received: "1.4.55",
                token: "nested-token",
                sessionCredential: "nested-session",
                credentialId: "nested-credential",
                path: privateHomePath,
                raw: { body: "nested-body" },
                stack: "nested-stack",
            }],
            timestamp: "2026-08-06T00:00:00.000Z",
            participant: { viewerId: 101 },
        },
    })
    const serialized = JSON.stringify(result)

    assert.doesNotMatch(serialized, /token|sessionCredential|credentialId|viewer|player|device|rawBody|stack/i)
    assert.equal(serialized.includes(privateHomePrefix), false)
    assert.doesNotMatch(serialized, /private\.json|top-secret|session-secret/)
    assert.deepEqual(result.latestCompatibilityRejection, {
        code: "INCOMPATIBLE_ROOM",
        differences: [{
            field: "RES_VER",
            different: true,
            required: "1.4.54",
            received: "1.4.55",
        }],
        timestamp: "2026-08-06T00:00:00.000Z",
    })
})

test("compatibility rejection retention is capacity-one, clipped, and TTL bounded", () => {
    assert.equal(typeof CompatibilityRejectionStore, "function")
    let now = Date.parse("2026-08-06T00:00:00.000Z")
    const store = new CompatibilityRejectionStore({ now: () => now, ttlMs: 1_000 })
    store.record({
        code: "INCOMPATIBLE_ROOM",
        differences: [{
            field: "contentDigest",
            required: `sha256:${"a".repeat(64)}`,
            received: `sha256:${"b".repeat(64)}`,
        }],
        token: "must-not-survive",
        viewerId: 101,
        body: path.join(privateHomePrefix, "example", "private-request.json"),
    })
    const first = store.get()
    assert.equal(first.code, "INCOMPATIBLE_ROOM")
    assert.deepEqual(first.differences, [{ field: "contentDigest", different: true }])
    assert.doesNotMatch(JSON.stringify(first), /sha256|a{16}|b{16}/i)
    assert.equal(JSON.stringify(first).includes(privateHomePrefix), false)
    assert.doesNotMatch(JSON.stringify(first), /must-not-survive|viewer/i)

    store.record({ code: "INCOMPATIBLE_ROOM", differences: [] })
    assert.deepEqual(store.get().differences, [])
    now += 1_001
    assert.equal(store.get(), null)
})

test("compatibility difference values cannot smuggle paths or credential-shaped text", () => {
    const store = new CompatibilityRejectionStore()
    store.record({
        code: "INCOMPATIBLE_ROOM",
        differences: [{
            field: "RES_VER",
            required: privateHomePath,
            received: "Bearer_secret-session-token",
        }],
    })

    const serialized = JSON.stringify(store.get())
    assert.equal(serialized.includes(privateHomePrefix), false)
    assert.doesNotMatch(serialized, /private\.json|Bearer|secret|session|token/i)
    assert.deepEqual(store.get().differences, [{ field: "RES_VER", different: true }])
})

test("version diagnostics never expose hash-like values", () => {
    const store = new CompatibilityRejectionStore()
    store.record({
        code: "INCOMPATIBLE_ROOM",
        differences: [{
            field: "APP_VER",
            required: "a".repeat(32),
            received: "b".repeat(32),
        }],
    })

    assert.deepEqual(store.get().differences, [{ field: "APP_VER", different: true }])
})

test("embedded compatibility mismatch records only bounded differences", async t => {
    const store = new CompatibilityRejectionStore()
    const coordinator = new EmbeddedMultiCoordinator({
        allowRemoteParticipants: true,
        onCompatibilityRejection: rejection => store.record(rejection),
    })
    const host = { nodeSessionId: "host-node", viewerId: 101 }
    const base = {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "1.4.54",
        cdnTargetVersion: "1.4.54",
        contentDigest: `sha256:${"a".repeat(64)}`,
        modeDigest: `sha256:${"b".repeat(64)}`,
    }
    const created = await coordinator.createRoom({
        requestId: "admin-compatibility",
        participant: host,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility: base,
    })
    assert.equal(created.ok, true)
    t.after(() => disbandRoom(created.value.roomNumber))

    const searched = await coordinator.searchRoom({
        participant: { nodeSessionId: "guest-node", viewerId: 202 },
        roomNumber: created.value.roomNumber,
        compatibility: { ...base, RES_VER: "1.4.55" },
    })

    assert.deepEqual(searched, { ok: false, error: "INCOMPATIBLE_ROOM" })
    assert.deepEqual(store.get().differences, [{
        field: "RES_VER",
        different: true,
        required: "1.4.54",
        received: "1.4.55",
    }])
    assert.doesNotMatch(JSON.stringify(store.get()), /host-node|guest-node|viewerId|participant/)
})

test("invalid compatibility headers record a code without request identity", () => {
    const rejections = []
    const factory = createCompatibilityProfileFactory({
        source: {
            cdnTargetVersion: "1.4.54",
            contentDigest: `sha256:${"a".repeat(64)}`,
            modeDigest: `sha256:${"b".repeat(64)}`,
        },
        onCompatibilityRejection: rejection => rejections.push(rejection),
    })

    assert.deepEqual(factory({ APP_VER: "1.8.1" }), {
        ok: false,
        error: "INCOMPATIBLE_ROOM",
    })
    assert.deepEqual(rejections, [{ code: "INCOMPATIBLE_ROOM", differences: [] }])
    assert.doesNotMatch(JSON.stringify(rejections), /header|request|viewer|player|device|body/i)
})

test("client runtime diagnostics refresh authority and degrade without guessed counts", async t => {
    let available = true
    let controlResult = {
        ok: true,
        value: {
            activeRooms: 7,
            activeBattleFacts: 5,
            finalizedBattleFacts: 2,
            latestCompatibilityRejection: null,
        },
    }
    const remote = {
        isAvailable: () => available,
        getTcpEndpoint: () => available ? { host: "hub.example", port: 8003 } : null,
        getNodeSessionId: () => available ? "node-session" : null,
        async getControlStatus() {
            if (!controlResult.ok) available = false
            return controlResult
        },
    }
    const service = createMultiRuntimeService({
        async startTcp() {},
        async stopTcp() {},
        isTcpListening: () => false,
        async startHub() {},
        async stopHub() {},
        isHubListening: () => false,
        createRemoteCoordinator: () => remote,
    })
    await service.start({
        mode: "client",
        hubUrl: new URL("https://hub.example/"),
        token: "a".repeat(32),
    })
    t.after(() => service.stop())

    const ready = await service.getAdminStatus()
    assert.equal(ready.state, "ready")
    assert.equal(ready.hub.available, true)
    assert.equal(ready.activeRooms, 7)
    assert.deepEqual(ready.battleFacts, { active: 5, finalized: 2 })

    controlResult = { ok: false, error: "HUB_UNAVAILABLE" }
    const degraded = await service.getAdminStatus()
    assert.equal(degraded.state, "degraded")
    assert.equal(degraded.hub.available, false)
    assert.equal(degraded.activeRooms, null)
    assert.equal(degraded.battleFacts, null)
})

test("runtime-not-started admin diagnostics use the same unavailable shape", async () => {
    const service = createMultiRuntimeService({
        async startTcp() {},
        async stopTcp() {},
        isTcpListening: () => false,
        async startHub() {},
        async stopHub() {},
        isHubListening: () => false,
    })
    const status = await service.getAdminStatus()
    assert.equal(status.mode, "embedded")
    assert.equal(status.state, "unavailable")
    assert.equal(status.activeRooms, null)
    assert.equal(status.battleFacts, null)
})

test("existing admin server status endpoint exposes multiplayer diagnostics read-only", async t => {
    const expected = buildAdminMultiStatus({
        runtime: runtime("host"),
        authority: { activeRooms: 1, activeBattleFacts: 2, finalizedBattleFacts: 3 },
        latestCompatibilityRejection: null,
    })
    const app = Fastify({ logger: false })
    await app.register(serverRoutes, {
        getMultiStatus: async () => expected,
    })
    await app.ready()
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/status" })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().multiplayer, expected)
    assert.equal(app.hasRoute({ method: "POST", url: "/status" }), false)
    assert.equal(app.hasRoute({ method: "GET", url: "/v1/multi/status" }), false)
    assert.doesNotMatch(response.body, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("Dashboard presents multiplayer diagnostics in Chinese without configuration controls", () => {
    const source = fs.readFileSync(path.join(repositoryRoot, "admin/src/pages/Dashboard.tsx"), "utf8")
    const styles = fs.readFileSync(path.join(repositoryRoot, "admin/src/styles.css"), "utf8")
    assert.match(source, /多人联机状态/)
    assert.match(source, /控制面连通性/)
    assert.match(source, /活跃房间/)
    assert.match(source, /兼容性拒绝/)
    assert.match(source, /期望/)
    assert.match(source, /实际/)
    assert.match(source, /摘要值已隐藏/)
    assert.match(source, /multi-compatibility-difference/)
    assert.doesNotMatch(source, /<Tag key=\{difference\.field\}/)
    assert.doesNotMatch(source, /MULTI_HUB_TOKEN|sessionCredential|编辑多人|保存多人|设置密钥/)
    assert.match(styles, /\.multi-compatibility-difference[\s\S]*overflow-wrap:\s*anywhere/)
    assert.match(styles, /\.multi-compatibility-difference[\s\S]*max-width:\s*100%/)
    assert.match(styles, /\.multi-compatibility-difference[\s\S]*min-width:\s*0/)
})
