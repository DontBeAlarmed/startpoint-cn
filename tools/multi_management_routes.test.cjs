"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")

const { MultiManagementService } = require("../src/multi/management/service")
const {
    MultiHubCredentialStoreError,
} = require("../src/multi/hub/credential-store")
const {
    MultiHubCredentialLockError,
} = require("../src/multi/hub/credential-lock")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")
const multiManagementRoutes = require("../src/routes/web_api/multi-management").default

const CREATED_AT = "2026-08-06T03:00:00.000Z"

async function createApp(t, getMultiManagementService) {
    const app = Fastify({ logger: false })
    app.register(multiManagementRoutes, {
        prefix: "/api/server/multiplayer",
        getMultiManagementService,
    })
    await app.ready()
    t.after(() => void app.close())
    return app
}

function request(app, method, url, options = {}) {
    return app.inject({
        method,
        url: `/api/server/multiplayer${url}`,
        remoteAddress: "127.0.0.1",
        ...options,
    })
}

test("management routes return a stable 503 until the lazy service is configured", async t => {
    let service = null
    const app = await createApp(t, () => service)

    const unavailable = await request(app, "GET", "/credentials")
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), {
        error: "Service Unavailable",
        code: "MULTI_MANAGEMENT_UNAVAILABLE",
        message: "Multiplayer management is not ready",
    })

    const diagnosticsUnavailable = await request(app, "GET", "/authentication-rejections")
    assert.equal(diagnosticsUnavailable.statusCode, 503)
    assert.deepEqual(diagnosticsUnavailable.json(), unavailable.json())

    service = {
        listCredentials: () => [],
        getAuthenticationDiagnostics: () => ({
            mode: "embedded",
            clientState: null,
            rejections: [],
        }),
    }
    const ready = await request(app, "GET", "/credentials")
    assert.equal(ready.statusCode, 200)
    assert.deepEqual(ready.json(), [])
})

test("loopback authentication rejection diagnostics return exact public fields", async t => {
    const calls = []
    const service = {
        getAuthenticationDiagnostics() {
            calls.push("diagnostics")
            return {
                mode: "host",
                clientState: null,
                token: "secret-root-token",
                host: "192.0.2.10:8002",
                rejections: [{
                    timestamp: CREATED_AT,
                    reason: "revoked",
                    credential: {
                        label: "node-a",
                        shortId: "aaaaaaaa",
                        credentialId: "a".repeat(32),
                        token: "secret-credential-token",
                    },
                    request: { body: "secret-request-body" },
                    digest: "secret-digest",
                    session: "secret-session",
                    stack: "/private/operator/path",
                }, {
                    timestamp: "2026-08-06T03:00:01.000Z",
                    reason: "unknown",
                    credential: null,
                    remoteAddress: "192.0.2.10",
                }],
            }
        },
    }
    const app = await createApp(t, () => service)

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
        mode: "host",
        clientState: null,
        rejections: [{
            timestamp: CREATED_AT,
            reason: "revoked",
            credential: { label: "node-a", shortId: "aaaaaaaa" },
        }, {
            timestamp: "2026-08-06T03:00:01.000Z",
            reason: "unknown",
            credential: null,
        }],
    })
    assert.doesNotMatch(
        response.body,
        /secret-|credentialId|request|body|digest|session|remoteAddress|192\.0\.2\.10|private|operator|path/,
    )
    assert.deepEqual(calls, ["diagnostics"])
})

test("authentication rejection route copies only the last 32 public events", async t => {
    const rejections = Array.from({ length: 33 }, (_, index) => ({
        timestamp: new Date(Date.parse(CREATED_AT) + index).toISOString(),
        reason: "unknown",
        credential: null,
        token: `secret-${index}`,
    }))
    const app = await createApp(t, () => ({
        getAuthenticationDiagnostics: () => ({
            mode: "host",
            clientState: null,
            rejections,
        }),
    }))

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.rejections.length, 32)
    assert.deepEqual(
        body.rejections.map(event => event.timestamp),
        rejections.slice(-32).map(event => event.timestamp),
    )
    assert.doesNotMatch(response.body, /secret-/)
})

test("authentication rejection route bounds sparse proxy reads and preserves its whitelist", async t => {
    const reportedLength = Number.MAX_SAFE_INTEGER
    const firstVisibleIndex = reportedLength - 32
    let indexAccesses = 0
    const rejections = new Proxy([], {
        has(target, property) {
            if (typeof property === "string" && /^\d+$/.test(property)) {
                indexAccesses++
                return Number(property) >= firstVisibleIndex
            }
            return Reflect.has(target, property)
        },
        get(target, property, receiver) {
            if (property === "length") return reportedLength
            if (typeof property === "string" && /^\d+$/.test(property)) {
                indexAccesses++
                const index = Number(property)
                if (index >= firstVisibleIndex) {
                    return {
                        timestamp: new Date(
                            Date.parse(CREATED_AT) + index - firstVisibleIndex,
                        ).toISOString(),
                        reason: "revoked",
                        credential: {
                            label: `node-${index}`,
                            shortId: index.toString(16).padStart(8, "0"),
                            token: "secret-credential-token",
                        },
                        request: { token: "secret-request-token" },
                    }
                }
            }
            return Reflect.get(target, property, receiver)
        },
    })
    const app = await createApp(t, () => ({
        getAuthenticationDiagnostics: () => ({
            mode: "host",
            clientState: null,
            rejections,
        }),
    }))

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().rejections.length, 32)
    assert.equal(indexAccesses, 32)
    assert.doesNotMatch(response.body, /secret-|request|token/)
})

test("authentication rejection route returns no events for an invalid array length", async t => {
    const rejections = new Proxy([], {
        get(target, property, receiver) {
            if (property === "length") return "1"
            if (property === "0") {
                return { timestamp: CREATED_AT, reason: "unknown", credential: null }
            }
            return Reflect.get(target, property, receiver)
        },
    })
    const app = await createApp(t, () => ({
        getAuthenticationDiagnostics: () => ({
            mode: "host",
            clientState: null,
            rejections,
        }),
    }))

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().rejections, [])
})

test("authentication rejection route skips malformed field values without leaking nested data", async t => {
    const app = await createApp(t, () => ({
        getAuthenticationDiagnostics: () => ({
            mode: "host",
            clientState: null,
            rejections: [{
                timestamp: { value: CREATED_AT, token: "secret-timestamp-token" },
                reason: "unknown",
                credential: null,
            }, {
                timestamp: CREATED_AT,
                reason: { value: "unknown", token: "secret-reason-token" },
                credential: null,
            }, {
                timestamp: CREATED_AT,
                reason: "revoked",
                credential: {
                    label: { value: "node-a", token: "secret-label-token" },
                    shortId: "aaaaaaaa",
                },
            }, {
                timestamp: CREATED_AT,
                reason: "malformed",
                credential: null,
            }],
        }),
    }))

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().rejections, [{
        timestamp: CREATED_AT,
        reason: "malformed",
        credential: null,
    }])
    assert.doesNotMatch(response.body, /secret-|value|token/)
})

test("loopback management routes delegate CRUD and probe with public response fields only", async t => {
    const calls = []
    const secretFields = {
        digest: "secret-digest",
        sessionCredential: "secret-session-credential",
        nodeSessionId: "secret-node-session",
        rawHubResponse: { token: "secret-raw-token" },
    }
    const service = {
        createCredential(label) {
            calls.push(["create", label])
            return {
                credentialId: "a".repeat(32),
                label,
                createdAt: CREATED_AT,
                revokedAt: null,
                token: "b".repeat(64),
                ...secretFields,
            }
        },
        listCredentials() {
            calls.push(["list"])
            return [{
                credentialId: "a".repeat(32),
                label: "node-a",
                createdAt: CREATED_AT,
                revokedAt: null,
                token: "must-not-be-listed",
                ...secretFields,
            }]
        },
        revokeCredential(credentialId) {
            calls.push(["revoke", credentialId])
            return {
                credentialId,
                label: "node-a",
                createdAt: CREATED_AT,
                revokedAt: CREATED_AT,
                token: "must-not-be-revoked",
                ...secretFields,
            }
        },
        async probeHub() {
            calls.push(["probe"])
            return {
                state: "ready",
                checkedAt: CREATED_AT,
                ...secretFields,
            }
        },
    }
    const app = await createApp(t, () => service)

    const created = await request(app, "POST", "/credentials", {
        headers: { "content-type": "application/json" },
        payload: { label: "node-a" },
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), {
        credentialId: "a".repeat(32),
        label: "node-a",
        createdAt: CREATED_AT,
        revokedAt: null,
        token: "b".repeat(64),
    })

    const listed = await request(app, "GET", "/credentials")
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.json(), [{
        credentialId: "a".repeat(32),
        label: "node-a",
        createdAt: CREATED_AT,
        revokedAt: null,
    }])

    const revoked = await request(app, "DELETE", `/credentials/${"a".repeat(32)}`)
    assert.equal(revoked.statusCode, 200)
    assert.deepEqual(revoked.json(), {
        credentialId: "a".repeat(32),
        label: "node-a",
        createdAt: CREATED_AT,
        revokedAt: CREATED_AT,
    })

    const probed = await request(app, "POST", "/probe")
    assert.equal(probed.statusCode, 200)
    assert.deepEqual(probed.json(), { state: "ready", checkedAt: CREATED_AT })

    for (const response of [created, listed, revoked, probed]) {
        assert.doesNotMatch(
            response.body,
            /secret-|digest|sessionCredential|nodeSessionId|rawHubResponse/,
        )
    }
    assert.deepEqual(calls, [
        ["create", "node-a"],
        ["list"],
        ["revoke", "a".repeat(32)],
        ["probe"],
    ])
})

test("all management actions reject non-loopback requests before touching the service", async t => {
    const calls = []
    const service = {
        createCredential: () => calls.push("create"),
        listCredentials: () => calls.push("list"),
        revokeCredential: () => calls.push("revoke"),
        probeHub: () => calls.push("probe"),
        getAuthenticationDiagnostics: () => calls.push("diagnostics"),
    }
    const app = await createApp(t, () => service)
    const requests = [
        ["GET", "/credentials", {}],
        ["POST", "/credentials", {
            headers: { "content-type": "application/json" },
            payload: { label: "node-a" },
        }],
        ["DELETE", `/credentials/${"a".repeat(32)}`, {}],
        ["POST", "/probe", {}],
        ["GET", "/authentication-rejections", {}],
    ]

    for (const [method, url, options] of requests) {
        const response = await request(app, method, url, {
            ...options,
            remoteAddress: "192.0.2.10",
        })
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.json(), {
            error: "Forbidden",
            code: "LOCAL_MANAGEMENT_ONLY",
            message: "This management operation requires a loopback request",
        })
    }
    assert.deepEqual(calls, [])
})

test("client mode rejects create, list, and revoke with one stable safe code", async t => {
    const calls = []
    const service = new MultiManagementService({
        mode: "client",
        credentials: {
            create: () => calls.push("create"),
            list: () => calls.push("list"),
            revoke: () => calls.push("revoke"),
        },
        getStatus: () => { throw new Error("not used") },
        probe: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
    })
    const app = await createApp(t, () => service)

    for (const [method, url, options] of [
        ["GET", "/credentials", {}],
        ["POST", "/credentials", {
            headers: { "content-type": "application/json" },
            payload: { label: "node-a" },
        }],
        ["DELETE", `/credentials/${"a".repeat(32)}`, {}],
    ]) {
        const response = await request(app, method, url, options)
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.json(), {
            error: "Forbidden",
            code: "CLIENT_MULTI_MANAGEMENT_UNAVAILABLE",
            message: "Credential management is unavailable in client mode",
        })
    }
    assert.deepEqual(calls, [])
})

test("management routes map store and unknown failures without exposing internal paths", async t => {
    let failure = new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIAL_LABEL")
    const app = await createApp(t, () => ({
        createCredential: () => { throw failure },
        listCredentials: () => { throw failure },
    }))

    const invalidLabel = await request(app, "POST", "/credentials", {
        headers: { "content-type": "application/json" },
        payload: { label: "" },
    })
    assert.equal(invalidLabel.statusCode, 400)
    assert.equal(invalidLabel.json().code, "INVALID_MULTI_HUB_CREDENTIAL_LABEL")

    failure = Object.assign(
        new MultiHubCredentialStoreError("INVALID_MULTI_HUB_CREDENTIALS_PATH"),
        { message: "INVALID_MULTI_HUB_CREDENTIALS_PATH: /private/operator/path" },
    )
    const unavailable = await request(app, "GET", "/credentials")
    assert.equal(unavailable.statusCode, 500)
    assert.deepEqual(unavailable.json(), {
        error: "Internal Server Error",
        code: "MULTI_HUB_CREDENTIALS_UNAVAILABLE",
        message: "Credential storage is unavailable",
    })
    assert.doesNotMatch(unavailable.body, /private|operator|path/)

    failure = new Error("raw hub response contained secret-token")
    const unknown = await request(app, "GET", "/credentials")
    assert.equal(unknown.statusCode, 500)
    assert.deepEqual(unknown.json(), {
        error: "Internal Server Error",
        code: "MULTI_MANAGEMENT_FAILED",
        message: "Multiplayer management request failed",
    })
    assert.doesNotMatch(unknown.body, /raw hub|secret-token/)
})

test("management routes map credential lock failures to storage unavailable", async t => {
    const app = await createApp(t, () => ({
        listCredentials: () => {
            throw new MultiHubCredentialLockError("MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT")
        },
    }))

    const response = await request(app, "GET", "/credentials")
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
        error: "Internal Server Error",
        code: "MULTI_HUB_CREDENTIALS_UNAVAILABLE",
        message: "Credential storage is unavailable",
    })
    assert.doesNotMatch(response.body, /LOCK_TIMEOUT/)
})

test("authentication diagnostic failures use the safe management error response", async t => {
    const app = await createApp(t, () => ({
        getAuthenticationDiagnostics: () => {
            throw new Error("secret-token at /private/operator/path")
        },
    }))

    const response = await request(app, "GET", "/authentication-rejections")
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
        error: "Internal Server Error",
        code: "MULTI_MANAGEMENT_FAILED",
        message: "Multiplayer management request failed",
    })
    assert.doesNotMatch(response.body, /secret-token|private|operator|path/)
})

test("runtime control probe calls only the client remote coordinator status method", async t => {
    const calls = []
    const remoteCoordinator = {
        getControlStatus: async () => {
            calls.push("getControlStatus")
            return { ok: true, value: { tcpAvailable: true } }
        },
        getExistingSessionControlStatus: async () => {
            calls.push("getExistingSessionControlStatus")
            throw new Error("must not be called")
        },
        createRoom: async () => {
            calls.push("createRoom")
            throw new Error("must not be called")
        },
        issueAdmission: async () => {
            calls.push("issueAdmission")
            throw new Error("must not be called")
        },
        getTcpEndpoint: () => null,
        getNodeSessionId: () => null,
        isAvailable: () => false,
    }
    const service = createMultiRuntimeService({
        startTcp: async () => { calls.push("startTcp") },
        stopTcp: async () => {},
        isTcpListening: () => false,
        startHub: async () => { calls.push("startHub") },
        stopHub: async () => {},
        isHubListening: () => false,
        createRemoteCoordinator: () => remoteCoordinator,
    })
    t.after(() => void service.stop())

    await service.start({
        mode: "client",
        hubUrl: new URL("https://hub.example/"),
        token: "a".repeat(64),
    })
    assert.deepEqual(await service.probeControlStatus(), {
        ok: true,
        value: { tcpAvailable: true },
    })
    assert.deepEqual(calls, ["getControlStatus"])
})

test("runtime control probe is safely unavailable outside an active client coordinator", async t => {
    const calls = []
    const service = createMultiRuntimeService({
        startTcp: async () => { calls.push("startTcp") },
        stopTcp: async () => {},
        isTcpListening: () => true,
        startHub: async () => { calls.push("startHub") },
        stopHub: async () => {},
        isHubListening: () => true,
    })
    t.after(() => void service.stop())

    assert.deepEqual(await service.probeControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    await service.start({
        mode: "embedded",
        tcp: { host: "127.0.0.1", port: 8003 },
    })
    calls.length = 0
    assert.deepEqual(await service.probeControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.deepEqual(calls, [])
})
