"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    MultiManagementService,
} = require("../src/multi/management/service")

const CHECKED_AT_MS = Date.parse("2026-08-06T03:00:00.000Z")
const CHECKED_AT = "2026-08-06T03:00:00.000Z"

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
