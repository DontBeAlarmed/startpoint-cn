"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    MultiManagementService,
} = require("../src/multi/management/service")

const CHECKED_AT_MS = Date.parse("2026-08-06T03:00:00.000Z")
const CHECKED_AT = "2026-08-06T03:00:00.000Z"
const REVOKED_CREDENTIAL_ID = "a".repeat(32)

function status() {
    return {
        mode: "client",
        state: "ready",
        coordinator: { kind: "remote", available: true },
        hub: { available: true, endpoint: "https://hub.example" },
        tcp: { available: true, endpoint: "hub.example:8003" },
        activeRooms: null,
        battleFacts: null,
        latestCompatibilityRejection: null,
    }
}

function createCredentials(calls) {
    return {
        create(label) {
            calls.push(["create", label])
            return { credentialId: "id", label, createdAt: CHECKED_AT, revokedAt: null, token: "token" }
        },
        list() {
            calls.push(["list"])
            return [{ credentialId: "id", label: "node", createdAt: CHECKED_AT, revokedAt: null }]
        },
        revoke(credentialId) {
            calls.push(["revoke", credentialId])
            return { credentialId, label: "node", createdAt: CHECKED_AT, revokedAt: CHECKED_AT }
        },
    }
}

function createService(mode, overrides = {}) {
    const calls = []
    const service = new MultiManagementService({
        mode,
        credentials: createCredentials(calls),
        getStatus: () => {
            calls.push(["getStatus"])
            return status()
        },
        probe: async () => {
            calls.push(["probe"])
            return { ok: true, value: { tcpAvailable: true } }
        },
        getAuthenticationDiagnostics: () => {
            calls.push(["getAuthenticationDiagnostics"])
            return { clientState: null, hostRejections: [] }
        },
        now: () => CHECKED_AT_MS,
        ...overrides,
    })
    return { calls, service }
}

test("credential management delegates create, list, and revoke to the injected store", () => {
    const fixture = createService("host")

    assert.deepEqual(fixture.service.createCredential("node"), {
        credentialId: "id",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: null,
        token: "token",
    })
    assert.deepEqual(fixture.service.listCredentials(), [{
        credentialId: "id",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: null,
    }])
    assert.deepEqual(fixture.service.revokeCredential("id"), {
        credentialId: "id",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: CHECKED_AT,
    })
    assert.deepEqual(fixture.calls, [
        ["create", "node"],
        ["list"],
        ["revoke", "id"],
    ])
})

test("credential and status results are copied and deeply frozen without freezing providers", async () => {
    const createdSource = {
        credentialId: "created",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: null,
        token: "token",
    }
    const listedSource = [{
        credentialId: "listed",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: null,
    }]
    const revokedSource = {
        credentialId: "revoked",
        label: "node",
        createdAt: CHECKED_AT,
        revokedAt: CHECKED_AT,
    }
    const statusSource = {
        ...status(),
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM",
            differences: [{ field: "APP_VER", different: true }],
            timestamp: CHECKED_AT,
        },
    }
    const fixture = createService("host", {
        credentials: {
            create: () => createdSource,
            list: () => listedSource,
            revoke: () => revokedSource,
        },
        getStatus: () => statusSource,
    })

    const created = fixture.service.createCredential("node")
    const listed = fixture.service.listCredentials()
    const revoked = fixture.service.revokeCredential("revoked")
    const actualStatus = await fixture.service.getStatus()

    assert.notEqual(created, createdSource)
    assert.equal(Object.isFrozen(created), true)
    assert.notEqual(listed, listedSource)
    assert.equal(Object.isFrozen(listed), true)
    assert.equal(Object.isFrozen(listed[0]), true)
    assert.notEqual(revoked, revokedSource)
    assert.equal(Object.isFrozen(revoked), true)
    assert.notEqual(actualStatus, statusSource)
    assert.equal(Object.isFrozen(actualStatus), true)
    assert.equal(Object.isFrozen(actualStatus.coordinator), true)
    assert.equal(Object.isFrozen(actualStatus.hub), true)
    assert.equal(Object.isFrozen(actualStatus.tcp), true)
    assert.equal(Object.isFrozen(actualStatus.latestCompatibilityRejection), true)
    assert.equal(Object.isFrozen(actualStatus.latestCompatibilityRejection.differences), true)
    assert.equal(Object.isFrozen(actualStatus.latestCompatibilityRejection.differences[0]), true)
    assert.equal(Object.isFrozen(createdSource), false)
    assert.equal(Object.isFrozen(listedSource), false)
    assert.equal(Object.isFrozen(listedSource[0]), false)
    assert.equal(Object.isFrozen(statusSource), false)
    assert.equal(Object.isFrozen(statusSource.coordinator), false)
    assert.equal(Object.isFrozen(statusSource.latestCompatibilityRejection), false)

    statusSource.tcp.available = false
    statusSource.latestCompatibilityRejection.differences[0].field = "RES_VER"
    assert.equal(actualStatus.tcp.available, true)
    assert.equal(actualStatus.latestCompatibilityRejection.differences[0].field, "APP_VER")
})

test("client mode rejects all host credential management with a stable error", () => {
    const fixture = createService("client")

    for (const operation of [
        () => fixture.service.createCredential("node"),
        () => fixture.service.listCredentials(),
        () => fixture.service.revokeCredential("id"),
    ]) {
        assert.throws(operation, error => {
            assert.equal(error.code, "CLIENT_MULTI_MANAGEMENT_UNAVAILABLE")
            assert.equal(error.message, "CLIENT_MULTI_MANAGEMENT_UNAVAILABLE")
            return true
        })
    }
    assert.deepEqual(fixture.calls, [])
})

test("getStatus returns the injected status provider result", async () => {
    const expected = status()
    const calls = []
    const fixture = createService("client", {
        getStatus: async () => {
            calls.push("status")
            return expected
        },
    })

    const actual = await fixture.service.getStatus()
    assert.deepEqual(actual, expected)
    assert.notEqual(actual, expected)
    assert.deepEqual(calls, ["status"])
})

test("embedded and host probes are not applicable without calling the network provider", async () => {
    for (const mode of ["embedded", "host"]) {
        const calls = []
        const fixture = createService(mode, {
            probe: async () => {
                calls.push("probe")
                throw new Error("network must not be called")
            },
        })

        assert.deepEqual(await fixture.service.probeHub(), {
            state: "not_applicable",
            checkedAt: CHECKED_AT,
        })
        assert.deepEqual(calls, [])
    }
})

test("probeHub safely handles now provider errors and NaN", async () => {
    for (const mode of ["client", "embedded", "host"]) {
        for (const now of [
            () => {
                throw new Error("clock unavailable")
            },
            () => Number.NaN,
        ]) {
            const calls = []
            const fixture = createService(mode, {
                now,
                probe: async () => {
                    calls.push("probe")
                    return { ok: true, value: { tcpAvailable: true } }
                },
            })

            assert.deepEqual(await fixture.service.probeHub(), {
                state: mode === "client" ? "unavailable" : "not_applicable",
                checkedAt: null,
            })
            assert.deepEqual(calls, [])
        }
    }
})

test("client probe maps a successful control status to ready without exposing the response", async () => {
    const fixture = createService("client", {
        probe: async () => ({
            ok: true,
            value: {
                activeNodeSessions: 1,
                enabledCredentials: 1,
                tcpAvailable: true,
                token: "secret-token",
                digest: "secret-digest",
                nodeSessionId: "secret-node-session",
                sessionCredential: "secret-session-credential",
            },
        }),
    })

    const result = await fixture.service.probeHub()
    assert.deepEqual(result, { state: "ready", checkedAt: CHECKED_AT })
    assert.doesNotMatch(JSON.stringify(result), /secret-(token|digest|node-session|session-credential)/)
})

test("client probe accepts a synchronous control status provider", async () => {
    const fixture = createService("client", {
        probe: () => ({ ok: true, value: { tcpAvailable: true } }),
    })

    assert.deepEqual(await fixture.service.probeHub(), {
        state: "ready",
        checkedAt: CHECKED_AT,
    })
})

test("client probe maps tcp unavailability to degraded", async () => {
    const fixture = createService("client", {
        probe: async () => ({ ok: true, value: { tcpAvailable: false } }),
    })

    assert.deepEqual(await fixture.service.probeHub(), {
        state: "degraded",
        checkedAt: CHECKED_AT,
    })
})

test("client probe maps HUB_UNAVAILABLE to unavailable", async () => {
    const fixture = createService("client", {
        probe: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
    })

    assert.deepEqual(await fixture.service.probeHub(), {
        state: "unavailable",
        checkedAt: CHECKED_AT,
    })
})

test("client probe safely maps provider exceptions and other errors to unavailable", async () => {
    for (const probe of [
        async () => {
            throw new Error(JSON.stringify({
                token: "secret-token",
                digest: "secret-digest",
                nodeSessionId: "secret-node-session",
                sessionCredential: "secret-session-credential",
            }))
        },
        async () => ({ ok: false, error: "ROOM_NOT_FOUND" }),
    ]) {
        const fixture = createService("client", { probe })
        const result = await fixture.service.probeHub()
        assert.deepEqual(result, { state: "unavailable", checkedAt: CHECKED_AT })
        assert.doesNotMatch(JSON.stringify(result), /secret-(token|digest|node-session|session-credential)/)
    }
})

test("probe only invokes the injected provider", async () => {
    const calls = []
    const fixture = createService("client", {
        getStatus: () => {
            calls.push("getStatus")
            return status()
        },
        probe: async () => {
            calls.push("getControlStatus")
            return { ok: true, value: { tcpAvailable: true } }
        },
    })

    await fixture.service.probeHub()
    assert.deepEqual(calls, ["getControlStatus"])
})

test("host authentication diagnostics safely project rejection events and revoked credential hints", () => {
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => [{
                credentialId: REVOKED_CREDENTIAL_ID,
                label: "node-a",
                createdAt: CHECKED_AT,
                revokedAt: CHECKED_AT,
                token: "secret-token",
                digest: "secret-digest",
            }],
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => ({
            clientState: "authentication_rejected",
            hostRejections: [
                {
                    timestamp: "2026-08-06T03:00:00Z",
                    reason: "malformed",
                    credentialId: "secret-malformed-id",
                    request: { token: "secret-malformed-token" },
                },
                {
                    timestamp: "2026-08-06T03:00:01.000Z",
                    reason: "unknown",
                    credentialId: "secret-unknown-id",
                    body: "secret-unknown-body",
                },
                {
                    timestamp: "2026-08-06T03:00:02.000Z",
                    reason: "revoked",
                    credentialId: REVOKED_CREDENTIAL_ID,
                    token: "secret-revoked-token",
                    stack: "/private/operator/path",
                },
                {
                    timestamp: "2026-08-06T03:00:03.000Z",
                    reason: "revoked",
                    credentialId: "b".repeat(32),
                    remoteAddress: "192.0.2.10",
                },
            ],
        }),
    })

    const result = fixture.service.getAuthenticationDiagnostics()
    assert.deepEqual(result, {
        mode: "host",
        clientState: null,
        rejections: [
            {
                timestamp: "2026-08-06T03:00:00.000Z",
                reason: "malformed",
                credential: null,
            },
            {
                timestamp: "2026-08-06T03:00:01.000Z",
                reason: "unknown",
                credential: null,
            },
            {
                timestamp: "2026-08-06T03:00:02.000Z",
                reason: "revoked",
                credential: { label: "node-a", shortId: "aaaaaaaa" },
            },
            {
                timestamp: "2026-08-06T03:00:03.000Z",
                reason: "revoked",
                credential: null,
            },
        ],
    })
    assert.doesNotMatch(
        JSON.stringify(result),
        /secret-|digest|token|request|body|remoteAddress|private|operator|path|aaaaaaaaaaaaaaaa/,
    )
})

test("host authentication diagnostics project only the last 32 rejection candidates", () => {
    const calls = []
    const events = Array.from({ length: 33 }, (_, index) => ({
        timestamp: new Date(CHECKED_AT_MS + index).toISOString(),
        reason: "unknown",
    }))
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => {
                calls.push("list")
                throw new Error("credentials must not be read")
            },
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => {
            calls.push("diagnostics")
            return { clientState: null, hostRejections: events }
        },
    })

    const result = fixture.service.getAuthenticationDiagnostics()
    assert.equal(result.rejections.length, 32)
    assert.deepEqual(
        result.rejections.map(event => event.timestamp),
        events.slice(-32).map(event => event.timestamp),
    )
    assert.deepEqual(calls, ["diagnostics"])
})

test("host authentication diagnostics bound sparse proxy rejection reads to the last 32 indices", () => {
    const reportedLength = Number.MAX_SAFE_INTEGER
    const firstVisibleIndex = reportedLength - 32
    let indexReads = 0
    const events = new Proxy([], {
        get(target, property, receiver) {
            if (property === "length") return reportedLength
            if (typeof property === "string" && /^\d+$/.test(property)) {
                indexReads++
                const index = Number(property)
                if (index >= firstVisibleIndex) {
                    return {
                        timestamp: new Date(CHECKED_AT_MS + index - firstVisibleIndex).toISOString(),
                        reason: "unknown",
                    }
                }
            }
            return Reflect.get(target, property, receiver)
        },
    })
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => { throw new Error("credentials must not be read") },
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => ({
            clientState: null,
            hostRejections: events,
        }),
    })

    const result = fixture.service.getAuthenticationDiagnostics()
    assert.equal(result.rejections.length, 32)
    assert.equal(indexReads, 32)
})

test("host authentication diagnostics reject invalid rejection array lengths", () => {
    const event = { timestamp: CHECKED_AT, reason: "unknown" }
    for (const invalidLength of ["1", 1.5, -1]) {
        const events = new Proxy([], {
            get(target, property, receiver) {
                if (property === "length") return invalidLength
                if (property === "0") return event
                return Reflect.get(target, property, receiver)
            },
        })
        const fixture = createService("host", {
            credentials: {
                create: () => { throw new Error("not used") },
                list: () => [],
                revoke: () => { throw new Error("not used") },
            },
            getAuthenticationDiagnostics: () => ({
                clientState: null,
                hostRejections: events,
            }),
        })

        assert.deepEqual(fixture.service.getAuthenticationDiagnostics().rejections, [])
    }
})

test("host authentication diagnostics do not scan oversized credential lists", () => {
    for (const reportedLength of [4_097, Number.MAX_SAFE_INTEGER]) {
        let indexReads = 0
        const credentials = new Proxy([], {
            get(target, property, receiver) {
                if (property === "length") return reportedLength
                if (typeof property === "string" && /^\d+$/.test(property)) indexReads++
                return Reflect.get(target, property, receiver)
            },
        })
        const fixture = createService("host", {
            credentials: {
                create: () => { throw new Error("not used") },
                list: () => credentials,
                revoke: () => { throw new Error("not used") },
            },
            getAuthenticationDiagnostics: () => ({
                clientState: null,
                hostRejections: [{
                    timestamp: CHECKED_AT,
                    reason: "revoked",
                    credentialId: REVOKED_CREDENTIAL_ID,
                }],
            }),
        })

        assert.deepEqual(fixture.service.getAuthenticationDiagnostics().rejections, [{
            timestamp: CHECKED_AT,
            reason: "revoked",
            credential: null,
        }])
        assert.equal(indexReads, 0)
    }
})

test("host authentication diagnostics stop credential scanning after wanted IDs are found", () => {
    let indexReads = 0
    const credentials = new Proxy([{
        credentialId: REVOKED_CREDENTIAL_ID,
        label: "node-a",
    }, {
        credentialId: "b".repeat(32),
        label: "unwanted-node",
    }], {
        get(target, property, receiver) {
            if (typeof property === "string" && /^\d+$/.test(property)) indexReads++
            return Reflect.get(target, property, receiver)
        },
    })
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => credentials,
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => ({
            clientState: null,
            hostRejections: [{
                timestamp: CHECKED_AT,
                reason: "revoked",
                credentialId: REVOKED_CREDENTIAL_ID,
            }],
        }),
    })

    assert.deepEqual(fixture.service.getAuthenticationDiagnostics().rejections, [{
        timestamp: CHECKED_AT,
        reason: "revoked",
        credential: { label: "node-a", shortId: "aaaaaaaa" },
    }])
    assert.equal(indexReads, 1)
})

test("client authentication diagnostics expose only the strict client state", () => {
    const calls = []
    const fixture = createService("client", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => {
                calls.push("list")
                throw new Error("credentials must not be read")
            },
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => {
            calls.push("diagnostics")
            return {
                clientState: "authentication_rejected",
                hostRejections: [{
                    timestamp: CHECKED_AT,
                    reason: "revoked",
                    credentialId: REVOKED_CREDENTIAL_ID,
                    token: "secret-token",
                }],
            }
        },
    })

    assert.deepEqual(fixture.service.getAuthenticationDiagnostics(), {
        mode: "client",
        clientState: "authentication_rejected",
        rejections: [],
    })
    assert.deepEqual(calls, ["diagnostics"])
})

test("embedded authentication diagnostics are empty without reading credentials", () => {
    const calls = []
    const fixture = createService("embedded", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => {
                calls.push("list")
                throw new Error("credentials must not be read")
            },
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => {
            calls.push("diagnostics")
            return {
                clientState: "authentication_rejected",
                hostRejections: [{
                    timestamp: CHECKED_AT,
                    reason: "revoked",
                    credentialId: REVOKED_CREDENTIAL_ID,
                }],
            }
        },
    })

    assert.deepEqual(fixture.service.getAuthenticationDiagnostics(), {
        mode: "embedded",
        clientState: null,
        rejections: [],
    })
    assert.deepEqual(calls, [])
})

test("host authentication diagnostics filter malformed provider values and invalid events", () => {
    const throwingEvent = {}
    Object.defineProperty(throwingEvent, "timestamp", {
        enumerable: true,
        get() { throw new Error("secret getter failure") },
    })
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => [null, "invalid", {
                credentialId: REVOKED_CREDENTIAL_ID,
                label: "node-a",
            }],
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => ({
            clientState: "secret-invalid-state",
            hostRejections: [
                null,
                "invalid",
                throwingEvent,
                { timestamp: "08/06/2026", reason: "malformed" },
                { timestamp: "2026-08-06", reason: "unknown" },
                { timestamp: "invalid-date", reason: "malformed" },
                { timestamp: CHECKED_AT, reason: "secret-reason", token: "secret-token" },
                {
                    timestamp: CHECKED_AT,
                    reason: "revoked",
                    credentialId: "not-a-complete-id",
                    credential: { token: "secret-token" },
                },
                { timestamp: CHECKED_AT, reason: "unknown", credentialId: Symbol("secret") },
            ],
        }),
    })

    const result = fixture.service.getAuthenticationDiagnostics()
    assert.deepEqual(result, {
        mode: "host",
        clientState: null,
        rejections: [
            { timestamp: CHECKED_AT, reason: "revoked", credential: null },
            { timestamp: CHECKED_AT, reason: "unknown", credential: null },
        ],
    })
    assert.doesNotMatch(JSON.stringify(result), /secret-|complete-id|token|credentialId/)
})

test("authentication diagnostics return fresh deeply frozen projections", () => {
    const source = {
        clientState: null,
        hostRejections: [{
            timestamp: CHECKED_AT,
            reason: "revoked",
            credentialId: REVOKED_CREDENTIAL_ID,
        }],
    }
    const fixture = createService("host", {
        credentials: {
            create: () => { throw new Error("not used") },
            list: () => [{
                credentialId: REVOKED_CREDENTIAL_ID,
                label: "node-a",
                createdAt: CHECKED_AT,
                revokedAt: CHECKED_AT,
            }],
            revoke: () => { throw new Error("not used") },
        },
        getAuthenticationDiagnostics: () => source,
    })

    const first = fixture.service.getAuthenticationDiagnostics()
    const second = fixture.service.getAuthenticationDiagnostics()
    assert.notEqual(first, second)
    assert.notEqual(first.rejections, second.rejections)
    assert.notEqual(first.rejections[0], second.rejections[0])
    assert.notEqual(first.rejections[0].credential, second.rejections[0].credential)
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.rejections), true)
    assert.equal(Object.isFrozen(first.rejections[0]), true)
    assert.equal(Object.isFrozen(first.rejections[0].credential), true)
    assert.equal(Object.isFrozen(source), false)
    assert.equal(Object.isFrozen(source.hostRejections), false)
    assert.equal(Object.isFrozen(source.hostRejections[0]), false)

    source.hostRejections[0].timestamp = "2026-08-07T00:00:00.000Z"
    assert.equal(first.rejections[0].timestamp, CHECKED_AT)
})
