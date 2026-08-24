"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { RemoteMultiCoordinator } = require("../src/multi/coordinator/remote")
const {
    AuthenticationRejectionBuffer,
} = require("../src/multi/hub/authentication-rejections")
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")
const { HubClient } = require("../src/multi/hub/client")
const { IdempotencyCache } = require("../src/multi/hub/idempotency")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")
const {
    isHubControlStatus,
    parseHubControlStatus,
} = require("../src/multi/hub/response-validator")
const { buildMultiHubControlApp } = require("../src/multi/hub/server")
const {
    addRoomMember,
    disbandRoom,
    getRoom,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")

const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})
const privateHomePrefix = path.join(path.sep, "Users") + path.sep

function snapshot(viewerId) {
    return Object.freeze({
        viewerId,
        name: `Player${viewerId}`,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 101,
        playerRoleKind: 1,
        isNewbie: true,
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

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

function roomStatus(participant, roomNumber = "123456") {
    return Object.freeze({
        roomNumber,
        accessToken: "access-token",
        category: 1,
        questId: 501,
        hostEntryTime: 1,
        roomSequence: 1,
        raisingState: 1,
        shareRoomOptions: 0,
        hostMainCharacterId: 101,
        isNpcMode: false,
        hostOnline: true,
        host: participant,
        members: [participant],
        compatibility,
    })
}

function createCoordinator() {
    const calls = []
    const results = new Map()
    const invoke = name => async input => {
        calls.push([name, input])
        const configured = results.get(name)
        if (configured instanceof Error) throw configured
        if (configured) return configured
        if (name === "disbandRoom" || name === "abortBattle") {
            return { ok: true, value: undefined }
        }
        if (name.includes("Battle")) {
            return {
                ok: true,
                value: {
                    battleSessionId: input.battleSessionId ?? "battle-session",
                    roomNumber: input.roomNumber ?? "123456",
                    host: input.participant,
                    participants: [input.participant],
                    finalized: name === "finalizeBattle",
                },
            }
        }
        return { ok: true, value: roomStatus(input.participant, input.roomNumber) }
    }
    return {
        calls,
        results,
        coordinator: Object.freeze({
            createRoom: invoke("createRoom"),
            searchRoom: invoke("searchRoom"),
            prepareRoom: invoke("prepareRoom"),
            selectRoom: invoke("selectRoom"),
            disbandRoom: invoke("disbandRoom"),
            abortBattle: invoke("abortBattle"),
            startBattle: invoke("startBattle"),
            finalizeBattle: invoke("finalizeBattle"),
            getBattleStatus: invoke("getBattleStatus"),
            getRoomStatus: invoke("getRoomStatus"),
            cleanupNodeSession: () => 0,
        }),
    }
}

function createTrackedEmbeddedCoordinator() {
    const calls = []
    const createResults = []
    const delegate = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const invoke = name => async input => {
        calls.push([name, input])
        const result = await delegate[name](input)
        if (name === "createRoom") createResults.push(result)
        return result
    }
    return {
        calls,
        createResults,
        delegate,
        results: new Map(),
        coordinator: Object.freeze({
            createRoom: invoke("createRoom"),
            searchRoom: invoke("searchRoom"),
            prepareRoom: invoke("prepareRoom"),
            selectRoom: invoke("selectRoom"),
            disbandRoom: invoke("disbandRoom"),
            abortBattle: invoke("abortBattle"),
            startBattle: invoke("startBattle"),
            finalizeBattle: invoke("finalizeBattle"),
            getBattleStatus: invoke("getBattleStatus"),
            getRoomStatus: invoke("getRoomStatus"),
            cleanupNodeSession: nodeSessionId => delegate.cleanupNodeSession(nodeSessionId),
        }),
    }
}

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-control-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "credentials.json")
    const store = new MultiHubCredentialStore({ credentialsPath })
    const first = store.create("node-a")
    const second = store.create("node-b")
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: options.warn ?? (() => {}),
    })
    assert.equal(reloader.reloadIfChanged(), true)
    let now = 10_000
    const authenticationRejections = new AuthenticationRejectionBuffer(() => now)
    let randomIndex = 0
    const randomValues = [
        "node-session-a", "session-credential-a".padEnd(43, "a"),
        "node-session-b", "session-credential-b".padEnd(43, "b"),
        "node-session-c", "session-credential-c".padEnd(43, "c"),
        "node-session-d", "session-credential-d".padEnd(43, "d"),
    ]
    const admissions = new AdmissionRegistry({
        now: () => now,
        getOccupiedMemberCount: options.getOccupiedMemberCount,
    })
    const coordinator = (options.coordinatorFactory ?? createCoordinator)()
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: options.sessionTtlMs ?? 5_000,
        generateId: () => randomValues[randomIndex++],
        isCredentialEnabled: credentialId => reloader.isCredentialEnabled(credentialId),
        onInvalidated: nodeSessionId => {
            admissions.removeByNodeSession(nodeSessionId)
            coordinator.coordinator.cleanupNodeSession(nodeSessionId)
        },
    })
    const idempotency = new IdempotencyCache({
        now: () => now,
        ttlMs: options.idempotencyTtlMs ?? 1_000,
        maxEntries: options.idempotencyMaxEntries ?? 32,
    })
    const app = buildMultiHubControlApp({
        coordinator: coordinator.coordinator,
        credentialReloader: reloader,
        authenticationRejections,
        nodeSessions: sessions,
        admissionIssuer: admissions,
        idempotency,
        getTcpEndpoint: options.getTcpEndpoint ?? (() => ({ host: "hub.internal", port: 8003 })),
        getDiagnostics: options.getDiagnostics ?? (() => ({
            activeRooms: 2,
            activeBattleFacts: 3,
            finalizedBattleFacts: 4,
            latestCompatibilityRejection: null,
        })),
    })
    t.after(() => app.close())
    return {
        admissions,
        app,
        authenticationRejections,
        coordinator,
        credentialsPath,
        first,
        reloader,
        second,
        sessions,
        getNow() { return now },
        setNow(value) { now = value },
        store,
    }
}

async function register(app, token, protocolVersion = MULTI_PROTOCOL_VERSION) {
    return app.inject({
        method: "POST",
        url: "/v1/multi/nodes/register",
        headers: { authorization: `Bearer ${token}` },
        payload: { protocolVersion },
    })
}

function sessionHeaders(registration, idempotencyKey) {
    const body = registration.json()
    const headers = {
        authorization: `Bearer ${body.sessionCredential}`,
        "x-node-session-id": body.nodeSessionId,
    }
    if (idempotencyKey !== undefined) headers["x-idempotency-key"] = idempotencyKey
    return headers
}

function participantInput(registration, viewerId = 101) {
    return {
        participant: {
            nodeSessionId: registration.json().nodeSessionId,
            viewerId,
        },
    }
}

function fetchThroughHub(app) {
    return async (url, init) => {
        const response = await app.inject({
            method: init.method,
            url: new URL(url).pathname,
            headers: init.headers,
            payload: init.body,
        })
        return new Response(response.body, {
            status: response.statusCode,
            headers: response.headers,
        })
    }
}

test("registers two independent credentials and exposes only the control route families", async t => {
    const target = fixture(t)
    const first = await register(target.app, target.first.token)
    const second = await register(target.app, target.second.token)

    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 200)
    assert.match(first.json().nodeSessionId, /^[A-Za-z0-9_-]+$/)
    assert.match(first.json().sessionCredential, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(first.json().nodeSessionId, second.json().nodeSessionId)
    assert.deepEqual(first.json().tcp, { host: "hub.internal", port: 8003 })
    assert.equal("credentialId" in first.json(), false)
    assert.equal((await target.app.inject({ method: "GET", url: "/api/player" })).statusCode, 404)
    assert.equal((await target.app.inject({ method: "GET", url: "/admin" })).statusCode, 404)
    assert.equal((await target.app.inject({ method: "GET", url: "/patch/cn/file" })).statusCode, 404)
})

test("TCP unavailability blocks registration and existing control operations", async t => {
    let tcpAvailable = true
    const target = fixture(t, {
        getTcpEndpoint: () => tcpAvailable ? { host: "hub.internal", port: 8003 } : null,
    })
    const registration = await register(target.app, target.first.token)
    assert.equal(registration.statusCode, 200)

    tcpAvailable = false
    const status = await target.app.inject({
        method: "GET",
        url: "/v1/multi/status",
        headers: sessionHeaders(registration),
    })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().value.tcpAvailable, false)
    const unavailable = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/status",
        headers: sessionHeaders(registration),
        payload: { participant: { viewerId: 101 }, roomNumber: "123456" },
    })
    assert.equal(unavailable.statusCode, 503)

    const rejected = await register(target.app, target.second.token)
    assert.equal(rejected.statusCode, 503)
    assert.equal(target.sessions.activeCount(), 1)
})

test("control server exposes only the exact route methods", async t => {
    const target = fixture(t)
    const registration = await register(target.app, target.first.token)
    const methods = ["OPTIONS", "PUT", "PATCH", "DELETE"]

    assert.equal((await target.app.inject({
        method: "GET",
        url: "/v1/multi/nodes/register",
    })).statusCode, 404)
    assert.equal((await target.app.inject({
        method: "HEAD",
        url: "/v1/multi/status",
        headers: sessionHeaders(registration),
    })).statusCode, 404)

    for (const method of methods) {
        const response = await target.app.inject({
            method,
            url: "/v1/multi/status",
            headers: sessionHeaders(registration),
        })
        assert.equal(response.statusCode, 404, `${method} status`)
    }

    assert.equal((await target.app.inject({
        method: "GET",
        url: "/v1/multi/rooms/status",
    })).statusCode, 404)
    for (const method of methods) {
        const response = await target.app.inject({
            method,
            url: "/v1/multi/nodes/register",
        })
        assert.equal(response.statusCode, 404, `${method} register`)
    }

    for (const url of ["/api/player", "/admin", "/patch/cn/file"]) {
        for (const method of ["GET", "HEAD", ...methods]) {
            const response = await target.app.inject({ method, url })
            assert.equal(response.statusCode, 404, `${method} ${url}`)
        }
    }

    const status = await target.app.inject({
        method: "GET",
        url: "/v1/multi/status",
        headers: sessionHeaders(registration),
    })
    assert.equal(status.statusCode, 200)
})

test("records only token authentication rejections behind a uniform registration response", async t => {
    const target = fixture(t)
    const missing = await target.app.inject({
        method: "POST",
        url: "/v1/multi/nodes/register",
        payload: { protocolVersion: MULTI_PROTOCOL_VERSION },
    })
    const malformed = await target.app.inject({
        method: "POST",
        url: "/v1/multi/nodes/register",
        headers: { authorization: "Bearer bad token" },
        payload: { protocolVersion: MULTI_PROTOCOL_VERSION },
    })
    const unknownToken = "z".repeat(64)
    const unknownWithIncompatibleProtocol = await register(
        target.app,
        unknownToken,
        MULTI_PROTOCOL_VERSION + 1,
    )
    assert.deepEqual(
        target.authenticationRejections.list().map(event => event.reason),
        ["malformed", "malformed", "unknown"],
    )
    target.store.revoke(target.first.credentialId)
    target.reloader.reloadIfChanged()
    const revoked = await register(target.app, target.first.token)
    const rejectionCountBeforeIncompatibleProtocol = target.authenticationRejections.list().length
    const incompatible = await register(
        target.app,
        target.second.token,
        MULTI_PROTOCOL_VERSION + 1,
    )
    assert.equal(
        target.authenticationRejections.list().length,
        rejectionCountBeforeIncompatibleProtocol,
    )

    const responses = [
        missing,
        malformed,
        unknownWithIncompatibleProtocol,
        revoked,
        incompatible,
    ]
    for (const response of responses) {
        assert.equal(response.statusCode, 401)
        assert.equal(response.body, '{"ok":false,"code":"UNAUTHORIZED"}')
        assert.deepEqual(response.json(), { ok: false, code: "UNAUTHORIZED" })
    }

    const events = target.authenticationRejections.list()
    assert.deepEqual(events.map(event => event.reason), [
        "malformed",
        "malformed",
        "unknown",
        "revoked",
    ])
    assert.equal(events.at(-1).credentialId, target.first.credentialId)
    assert.equal(events.length, 4)

    const serialized = JSON.stringify(events).toLowerCase()
    for (const forbidden of ["token", "digest", "request", "address", "session"]) {
        assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    assert.equal(serialized.includes(unknownToken.toLowerCase()), false)
    assert.equal(serialized.includes(target.first.token.toLowerCase()), false)

    target.sessions.register = () => { throw new Error("registration failed") }
    const registrationFailure = await register(target.app, target.second.token)
    assert.equal(registrationFailure.statusCode, 401)
    assert.equal(registrationFailure.body, responses[0].body)
    assert.equal(target.authenticationRejections.list().length, 4)
})

test("expires sessions fail closed and revocation invalidates only matching credentials", async t => {
    const target = fixture(t)
    const first = await register(target.app, target.first.token)
    const second = await register(target.app, target.second.token)
    const input = { ...participantInput(first), roomNumber: "123456" }

    target.store.revoke(target.first.credentialId)
    target.reloader.reloadIfChanged()
    const revoked = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/status",
        headers: sessionHeaders(first),
        payload: input,
    })
    assert.equal(revoked.statusCode, 401)
    assert.equal(target.sessions.has(first.json().nodeSessionId), false)

    const valid = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/status",
        headers: sessionHeaders(second),
        payload: { ...participantInput(second), roomNumber: "123456" },
    })
    assert.equal(valid.statusCode, 200)

    target.setNow(20_000)
    const expired = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/status",
        headers: sessionHeaders(second),
        payload: { ...participantInput(second), roomNumber: "123456" },
    })
    assert.equal(expired.statusCode, 401)
    assert.equal(target.sessions.has(second.json().nodeSessionId), false)
})

test("active node sessions remain valid past their original expiry and expire after idle TTL", async t => {
    const target = fixture(t)
    const registration = await register(target.app, target.first.token)
    const nodeSessionId = registration.json().nodeSessionId

    target.setNow(14_000)
    assert.equal(target.sessions.isValid(nodeSessionId), true)

    target.setNow(16_000)
    assert.equal(target.sessions.isValid(nodeSessionId), true)

    target.setNow(21_001)
    assert.equal(target.sessions.isValid(nodeSessionId), false)
})

test("revoking a shared credential invalidates all of its sessions but not a peer credential", async t => {
    const target = fixture(t)
    const firstNode = await register(target.app, target.first.token)
    const secondNode = await register(target.app, target.first.token)
    target.store.revoke(target.first.credentialId)
    target.reloader.reloadIfChanged()

    for (const registration of [firstNode, secondNode]) {
        const response = await target.app.inject({
            method: "POST",
            url: "/v1/multi/rooms/status",
            headers: sessionHeaders(registration),
            payload: { ...participantInput(registration), roomNumber: "123456" },
        })
        assert.equal(response.statusCode, 401)
        assert.equal(target.sessions.has(registration.json().nodeSessionId), false)
    }

    const peer = await register(target.app, target.second.token)
    assert.equal(peer.statusCode, 200)
})

test("delegates every room and battle operation with the authenticated node identity", async t => {
    const target = fixture(t)
    const registration = await register(target.app, target.first.token)
    const participant = participantInput(registration, 202).participant
    const roomMutation = {
        participant: { nodeSessionId: "forged", viewerId: participant.viewerId },
        requestId: "request-1",
        localPlayerId: 99,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    }
    const operations = [
        ["/v1/multi/rooms/create", "createRoom", roomMutation, true],
        ["/v1/multi/rooms/search", "searchRoom", { participant, roomNumber: "123456", compatibility }, false],
        ["/v1/multi/rooms/prepare", "prepareRoom", { participant, roomNumber: "123456", compatibility }, true],
        ["/v1/multi/rooms/select", "selectRoom", { participant, accessToken: "access-token", compatibility }, false],
        ["/v1/multi/rooms/disband", "disbandRoom", { participant, roomNumber: "123456" }, true],
        ["/v1/multi/rooms/status", "getRoomStatus", { participant, roomNumber: "123456" }, false],
        ["/v1/multi/battles/start", "startBattle", { participant, roomNumber: "123456" }, true],
        ["/v1/multi/battles/abort", "abortBattle", { participant, roomNumber: "123456" }, true],
        ["/v1/multi/battles/finalize", "finalizeBattle", { participant, roomNumber: "123456", battleSessionId: "battle-session" }, true],
        ["/v1/multi/battles/status", "getBattleStatus", { participant, roomNumber: "123456", battleSessionId: "battle-session" }, false],
    ]

    for (const [url, method, payload, write] of operations) {
        const response = await target.app.inject({
            method: "POST",
            url,
            headers: sessionHeaders(registration, write ? `key-${method}` : undefined),
            payload,
        })
        assert.equal(response.statusCode, 200, `${method}: ${response.body}`)
        const call = target.coordinator.calls.find(([name]) => name === method)
        assert.ok(call, method)
        assert.equal(call[1].participant.nodeSessionId, registration.json().nodeSessionId)
        assert.equal(call[1].participant.viewerId, 202)
        assert.equal(call[1].credentialId, target.first.credentialId)
    }
})

test("issues node-scoped admissions and removes them when the node session expires", async t => {
    const target = fixture(t)
    const registration = await register(target.app, target.first.token)
    const participant = participantInput(registration, 303).participant
    const response = await target.app.inject({
        method: "POST",
        url: "/v1/multi/admissions/issue",
        headers: sessionHeaders(registration, "admission-1"),
        payload: {
            roomNumber: "123456",
            participant,
            snapshot: snapshot(303),
            expiresAt: 14_000,
        },
    })

    assert.equal(response.statusCode, 200)
    target.setNow(20_000)
    assert.equal(target.sessions.isValid(registration.json().nodeSessionId), false)
    assert.equal(target.admissions.consume("123456", 303), null)
})

test("Host Hub admission round-trip enforces and releases ROOM_FULL", async t => {
    const target = fixture(t, { getOccupiedMemberCount: () => 2 })
    const registration = await register(target.app, target.first.token)
    const issueAdmission = (viewerId, idempotencyKey) => target.app.inject({
        method: "POST",
        url: "/v1/multi/admissions/issue",
        headers: sessionHeaders(registration, idempotencyKey),
        payload: {
            roomNumber: "123456",
            participant: participantInput(registration, viewerId).participant,
            snapshot: snapshot(viewerId),
            expiresAt: 14_000,
        },
    })

    const first = await issueAdmission(202, "admission-full-1")
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json().ok, true)

    const full = await issueAdmission(303, "admission-full-2")
    assert.equal(full.statusCode, 200)
    assert.deepEqual(full.json(), { ok: false, code: "ROOM_FULL" })

    assert.equal(target.admissions.release("123456", 202), true)
    const reusable = await issueAdmission(303, "admission-full-3")
    assert.equal(reusable.statusCode, 200)
    assert.deepEqual(reusable.json().ok, true)
})

test("requires bounded ASCII idempotency keys and isolates cached writes by node session and TTL", async t => {
    const target = fixture(t, { idempotencyTtlMs: 100 })
    const firstNode = await register(target.app, target.first.token)
    const payload = {
        ...participantInput(firstNode),
        requestId: "request-1",
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    }

    for (const key of [undefined, "é", " ".repeat(2), "a".repeat(129)]) {
        const response = await target.app.inject({
            method: "POST",
            url: "/v1/multi/rooms/create",
            headers: sessionHeaders(firstNode, key),
            payload,
        })
        assert.equal(response.statusCode, 400)
        assert.deepEqual(response.json(), { ok: false, code: "INVALID_IDEMPOTENCY_KEY" })
    }

    const invoke = registration => target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/create",
        headers: sessionHeaders(registration, "same-key"),
        payload: {
            ...payload,
            participant: participantInput(registration).participant,
        },
    })
    const firstResult = await invoke(firstNode)
    const replay = await invoke(firstNode)
    assert.equal(firstResult.body, replay.body)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 1)

    const refreshedNode = await register(target.app, target.first.token)
    const refreshedResult = await invoke(refreshedNode)
    assert.notEqual(refreshedResult.body, firstResult.body)
    assert.equal(refreshedResult.json().value.host.nodeSessionId, "node-session-b")
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 2)

    const otherCredential = await register(target.app, target.second.token)
    await invoke(otherCredential)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 3)

    target.setNow(10_101)
    await invoke(firstNode)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 4)
})

test("lost create response rebuilds live state after expired-session teardown", async t => {
    const target = fixture(t, {
        coordinatorFactory: createTrackedEmbeddedCoordinator,
        sessionTtlMs: 100,
        idempotencyTtlMs: 10_000,
    })
    t.after(() => {
        target.coordinator.coordinator.cleanupNodeSession("node-session-a")
        target.coordinator.coordinator.cleanupNodeSession("node-session-b")
    })
    let loseMutationResponse = true
    let cleanupObserved = false
    const fetchFromHub = async (url, init) => {
        const route = new URL(url).pathname
        const response = await target.app.inject({
            method: init.method,
            url: route,
            headers: init.headers,
            payload: init.body,
        })
        if (route === "/v1/multi/rooms/create" && loseMutationResponse) {
            loseMutationResponse = false
            const first = target.coordinator.createResults[0]
            assert.equal(first.ok, true)
            target.admissions.issue({
                roomNumber: first.value.roomNumber,
                participant: first.value.host,
                snapshot: snapshot(first.value.host.viewerId),
                expiresAt: 20_000,
            })
            target.setNow(10_100)
            throw new TypeError("response lost after mutation")
        }
        if (route === "/v1/multi/rooms/create" && response.statusCode === 401) {
            const first = target.coordinator.createResults[0]
            assert.equal(first.ok, true)
            assert.deepEqual(await target.coordinator.delegate.getRoomStatus({
                participant: { nodeSessionId: "observer", viewerId: 999 },
                roomNumber: first.value.roomNumber,
            }), { ok: false, error: "ROOM_NOT_FOUND" })
            assert.equal(target.admissions.consume(first.value.roomNumber, 101), null)
            cleanupObserved = true
        }
        return new Response(response.body, {
            status: response.statusCode,
            headers: response.headers,
        })
    }
    const input = {
        requestId: "lost-response",
        participant: { nodeSessionId: "pending", viewerId: 101 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    }
    const firstClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchFromHub,
        now: () => target.getNow(),
        createIdempotencyKey: () => "lost-response-key",
    })
    const replayed = await firstClient.write("/v1/multi/rooms/create", input)
    assert.equal(replayed.ok, true)
    assert.equal(cleanupObserved, true)
    assert.equal(firstClient.getNodeSessionId(), "node-session-b")
    assert.equal(target.coordinator.createResults.length, 2)
    const [removed, live] = target.coordinator.createResults
    assert.equal(removed.ok, true)
    assert.equal(live.ok, true)
    assert.equal(live.value.host.nodeSessionId, "node-session-b")
    assert.equal(replayed.value.roomNumber, live.value.roomNumber)
    assert.equal(replayed.value.host.nodeSessionId, "node-session-b")

    const status = await firstClient.read("/v1/multi/rooms/status", {
        participant: input.participant,
        roomNumber: live.value.roomNumber,
    })
    assert.equal(status.ok, true)
    assert.equal(status.value.roomNumber, live.value.roomNumber)
    assert.equal(status.value.host.nodeSessionId, "node-session-b")
    t.after(() => target.coordinator.coordinator.cleanupNodeSession("node-session-b"))
})

test("pending write capacity returns bounded unavailable without evicting the replay", async t => {
    const target = fixture(t, { idempotencyMaxEntries: 1 })
    const registration = await register(target.app, target.first.token)
    const coordinatorResult = deferred()
    target.coordinator.results.set("createRoom", coordinatorResult.promise)
    const payload = {
        ...participantInput(registration),
        requestId: "pending-room",
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    }
    const invoke = key => target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/create",
        headers: sessionHeaders(registration, key),
        payload,
    })
    const first = invoke("pending-a")
    while (target.coordinator.calls.length === 0) {
        await new Promise(resolve => setImmediate(resolve))
    }
    const atCapacity = invoke("pending-b")
    let capacitySettled = false
    void atCapacity.then(() => { capacitySettled = true })
    for (let attempt = 0; attempt < 100
        && !capacitySettled
        && target.coordinator.calls.length === 1; attempt++) {
        await new Promise(resolve => setImmediate(resolve))
    }
    const replay = invoke("pending-a")
    await new Promise(resolve => setImmediate(resolve))
    const callsBeforeSettlement = target.coordinator.calls.length

    coordinatorResult.resolve({ ok: true, value: roomStatus(
        participantInput(registration).participant,
        "pending-room",
    ) })
    const [firstResponse, capacityResponse, replayResponse] = await Promise.all([
        first,
        atCapacity,
        replay,
    ])

    assert.equal(callsBeforeSettlement, 1)
    assert.equal(capacityResponse.statusCode, 503)
    assert.deepEqual(capacityResponse.json(), { ok: false, code: "HUB_UNAVAILABLE" })
    assert.equal(firstResponse.body, replayResponse.body)
    assert.equal(target.coordinator.calls.length, 1)
})

test("returns bounded coordinator errors without paths, credentials or stack traces", async t => {
    const target = fixture(t)
    const registration = await register(target.app, target.first.token)
    target.coordinator.results.set("searchRoom", { ok: false, error: "INCOMPATIBLE_ROOM" })
    const incompatible = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/search",
        headers: sessionHeaders(registration),
        payload: {
            ...participantInput(registration),
            roomNumber: "123456",
            compatibility,
        },
    })
    assert.equal(incompatible.statusCode, 200)
    assert.deepEqual(incompatible.json(), { ok: false, code: "INCOMPATIBLE_ROOM" })

    target.coordinator.results.set("searchRoom", { ok: false, error: "ROOM_FULL" })
    const full = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/search",
        headers: sessionHeaders(registration),
        payload: {
            ...participantInput(registration),
            roomNumber: "123456",
            compatibility,
        },
    })
    assert.equal(full.statusCode, 200)
    assert.deepEqual(full.json(), { ok: false, code: "ROOM_FULL" })

    target.coordinator.results.set("getRoomStatus", new Error(`secret ${target.first.token} ${target.credentialsPath}`))
    const unavailable = await target.app.inject({
        method: "POST",
        url: "/v1/multi/rooms/status",
        headers: sessionHeaders(registration),
        payload: { ...participantInput(registration), roomNumber: "123456" },
    })
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), { ok: false, code: "HUB_UNAVAILABLE" })
    assert.equal(unavailable.body.includes(target.first.token), false)
    assert.equal(unavailable.body.includes(target.credentialsPath), false)
    assert.equal(unavailable.body.includes("stack"), false)

    const status = await target.app.inject({
        method: "GET",
        url: "/v1/multi/status",
        headers: sessionHeaders(registration),
    })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(Object.keys(status.json().value).sort(), [
        "activeBattleFacts",
        "activeNodeSessions",
        "activeRooms",
        "enabledCredentials",
        "finalizedBattleFacts",
        "latestCompatibilityRejection",
        "tcpAvailable",
    ])
    assert.equal(status.body.includes(target.first.label), false)
})

test("HubClient reads bounded authoritative diagnostics through the existing control plane", async t => {
    const target = fixture(t)
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })

    assert.deepEqual(await client.getControlStatus(), {
        ok: true,
        value: {
            activeNodeSessions: 1,
            enabledCredentials: 2,
            tcpAvailable: true,
            activeRooms: 2,
            activeBattleFacts: 3,
            finalizedBattleFacts: 4,
            latestCompatibilityRejection: null,
        },
    })
})

test("concurrent HubClient control calls share one registration", async t => {
    const target = fixture(t)
    const delegate = fetchThroughHub(target.app)
    const registrationCaptured = deferred()
    const releaseRegistration = deferred()
    let registrationRequests = 0
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            if (new URL(url).pathname === "/v1/multi/nodes/register") {
                registrationRequests++
                registrationCaptured.resolve()
                await releaseRegistration.promise
            }
            return delegate(url, init)
        },
    })

    const first = client.getControlStatus()
    await registrationCaptured.promise
    const second = client.getControlStatus()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(registrationRequests, 1)

    releaseRegistration.resolve()
    const [firstStatus, secondStatus] = await Promise.all([first, second])
    assert.equal(firstStatus.ok, true)
    assert.equal(secondStatus.ok, true)
    assert.equal(registrationRequests, 1)
    assert.equal(target.sessions.activeCount(), 1)
    assert.equal(client.isAvailable(), true)
    assert.deepEqual(client.getTcpEndpoint(), { host: "hub.internal", port: 8003 })
    assert.match(client.getNodeSessionId(), /^node-session-/)
    assert.equal(client.getAuthenticationState(), null)
})

test("HubClient records authentication rejection only for registration 401", async t => {
    const target = fixture(t)
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: "z".repeat(32),
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })

    assert.deepEqual(await client.getControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.getAuthenticationState(), "authentication_rejected")
})

test("HubClient leaves authentication state unchanged on registration network failure", async () => {
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: "a".repeat(32),
        fetch: async () => {
            throw new Error("network unavailable")
        },
    })

    assert.deepEqual(await client.getControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.getAuthenticationState(), null)
})

test("HubClient preserves authentication rejection across registration network outages", async t => {
    const target = fixture(t)
    const delegate = fetchThroughHub(target.app)
    let registrationAttempts = 0
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            if (new URL(url).pathname === "/v1/multi/nodes/register") {
                registrationAttempts++
                if (registrationAttempts === 1) {
                    return delegate(url, {
                        ...init,
                        headers: {
                            ...init.headers,
                            authorization: `Bearer ${"z".repeat(32)}`,
                        },
                    })
                }
                throw new Error("network unavailable")
            }
            return delegate(url, init)
        },
    })

    assert.deepEqual(await client.getControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.getAuthenticationState(), "authentication_rejected")

    assert.deepEqual(await client.getControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.equal(registrationAttempts, 2)
    assert.equal(client.getAuthenticationState(), "authentication_rejected")
})

test("HubClient clears authentication rejection after a valid registration", async t => {
    const target = fixture(t)
    const delegate = fetchThroughHub(target.app)
    let rejectNextRegistration = true
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: (url, init) => {
            if (rejectNextRegistration
                && new URL(url).pathname === "/v1/multi/nodes/register") {
                rejectNextRegistration = false
                return delegate(url, {
                    ...init,
                    headers: {
                        ...init.headers,
                        authorization: `Bearer ${"z".repeat(32)}`,
                    },
                })
            }
            return delegate(url, init)
        },
    })

    assert.deepEqual(await client.getControlStatus(), {
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.getAuthenticationState(), "authentication_rejected")

    const status = await client.getControlStatus()
    assert.equal(status.ok, true)
    assert.equal(status.value.tcpAvailable, true)
    assert.equal(client.getAuthenticationState(), null)
})

test("explicit control status degrades a client when Host TCP stops", async t => {
    let tcpAvailable = true
    const target = fixture(t, {
        getTcpEndpoint: () => tcpAvailable ? { host: "hub.internal", port: 8003 } : null,
    })
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    assert.equal((await client.getControlStatus()).ok, true)
    assert.deepEqual(client.getTcpEndpoint(), { host: "hub.internal", port: 8003 })

    tcpAvailable = false
    const status = await client.getControlStatus()
    assert.equal(status.ok, true)
    assert.equal(status.value.tcpAvailable, false)
    assert.equal(client.isAvailable(), false)
    assert.equal(client.getTcpEndpoint(), null)
})

test("existing-session status polling applies authoritative TCP unavailability", async t => {
    let tcpAvailable = true
    const target = fixture(t, {
        getTcpEndpoint: () => tcpAvailable ? { host: "hub.internal", port: 8003 } : null,
    })
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    assert.equal((await client.getControlStatus()).ok, true)
    assert.equal(client.isAvailable(), true)

    tcpAvailable = false
    const status = await client.getExistingSessionControlStatus()
    assert.equal(status.tcpAvailable, false)
    assert.equal(client.isAvailable(), false)
    assert.equal(client.getTcpEndpoint(), null)
})

test("a delayed old-session 401 cannot clear a refreshed HubClient session", async t => {
    const target = fixture(t)
    const delegate = fetchThroughHub(target.app)
    const oldUnauthorizedCaptured = deferred()
    const releaseOldUnauthorized = deferred()
    let delayNextUnauthorizedStatus = false
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            const response = await delegate(url, init)
            if (delayNextUnauthorizedStatus
                && new URL(url).pathname === "/v1/multi/status"
                && response.status === 401) {
                delayNextUnauthorizedStatus = false
                oldUnauthorizedCaptured.resolve()
                await releaseOldUnauthorized.promise
            }
            return response
        },
    })
    assert.equal((await client.getControlStatus()).ok, true)
    const oldNodeSessionId = client.getNodeSessionId()
    target.sessions.clear()

    delayNextUnauthorizedStatus = true
    const older = client.getControlStatus()
    await oldUnauthorizedCaptured.promise
    const newer = await client.getControlStatus()
    assert.equal(newer.ok, true)
    const refreshedNodeSessionId = client.getNodeSessionId()
    assert.notEqual(refreshedNodeSessionId, oldNodeSessionId)
    assert.equal(client.getAuthenticationState(), null)
    assert.equal(client.isAvailable(), true)

    releaseOldUnauthorized.resolve()
    assert.equal((await older).ok, true)
    assert.equal(client.getNodeSessionId(), refreshedNodeSessionId)
    assert.equal(target.sessions.activeCount(), 1)
    assert.equal(client.getAuthenticationState(), null)
    assert.equal(client.isAvailable(), true)
    assert.deepEqual(client.getTcpEndpoint(), { host: "hub.internal", port: 8003 })
})

test("an older TCP status response cannot override a newer degradation", async t => {
    let tcpAvailable = true
    let delayNextStatus = false
    const firstStatusCaptured = deferred()
    const releaseFirstStatus = deferred()
    const target = fixture(t, {
        getTcpEndpoint: () => tcpAvailable ? { host: "hub.internal", port: 8003 } : null,
    })
    const delegate = fetchThroughHub(target.app)
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            const response = await delegate(url, init)
            if (delayNextStatus && new URL(url).pathname === "/v1/multi/status") {
                delayNextStatus = false
                firstStatusCaptured.resolve()
                await releaseFirstStatus.promise
            }
            return response
        },
    })
    assert.equal((await client.getControlStatus()).ok, true)

    delayNextStatus = true
    const older = client.getExistingSessionControlStatus()
    await firstStatusCaptured.promise
    tcpAvailable = false
    const newer = await client.getExistingSessionControlStatus()
    assert.equal(newer.tcpAvailable, false)
    assert.equal(client.isAvailable(), false)

    releaseFirstStatus.resolve()
    assert.equal((await older).tcpAvailable, true)
    assert.equal(client.isAvailable(), false)
    assert.equal(client.getTcpEndpoint(), null)
})

test("an older room response cannot override a newer TCP degradation", async t => {
    let tcpAvailable = true
    let delayNextRoomStatus = false
    const roomResponseCaptured = deferred()
    const releaseRoomResponse = deferred()
    const target = fixture(t, {
        getTcpEndpoint: () => tcpAvailable ? { host: "hub.internal", port: 8003 } : null,
    })
    const delegate = fetchThroughHub(target.app)
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            const response = await delegate(url, init)
            if (delayNextRoomStatus
                && new URL(url).pathname === "/v1/multi/rooms/status") {
                delayNextRoomStatus = false
                roomResponseCaptured.resolve()
                await releaseRoomResponse.promise
            }
            return response
        },
    })
    assert.equal((await client.getControlStatus()).ok, true)

    delayNextRoomStatus = true
    const older = client.read("/v1/multi/rooms/status", {
        participant: { nodeSessionId: "pending", viewerId: 101 },
        roomNumber: "123456",
    })
    await roomResponseCaptured.promise
    tcpAvailable = false
    assert.equal((await client.getExistingSessionControlStatus()).tcpAvailable, false)
    assert.equal(client.isAvailable(), false)

    releaseRoomResponse.resolve()
    assert.equal((await older).ok, true)
    assert.equal(client.isAvailable(), false)
    assert.equal(client.getTcpEndpoint(), null)
})

test("HubClient diagnostics use only an existing session and never change availability", async t => {
    const target = fixture(t)
    let failStatus = false
    let statusRequests = 0
    const delegate = fetchThroughHub(target.app)
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        now: () => target.getNow(),
        fetch: async (url, init) => {
            if (new URL(url).pathname === "/v1/multi/status") {
                statusRequests++
                if (failStatus) throw new Error("diagnostic failure")
            }
            return delegate(url, init)
        },
    })

    assert.equal(await client.getExistingSessionControlStatus(), null)
    assert.equal(statusRequests, 0)
    assert.equal(target.sessions.activeCount(), 0)
    assert.equal(client.isAvailable(), false)

    const coreResult = await client.read("/v1/multi/rooms/status", {
        participant: { nodeSessionId: "pending", viewerId: 101 },
        roomNumber: "999999",
    })
    assert.equal(coreResult.ok, true)
    assert.equal(target.sessions.activeCount(), 1)
    assert.equal(client.isAvailable(), true)

    const diagnostics = await client.getExistingSessionControlStatus()
    assert.equal(diagnostics.activeRooms, 2)
    assert.equal(statusRequests, 1)
    assert.equal(target.sessions.activeCount(), 1)
    assert.equal(client.isAvailable(), true)

    failStatus = true
    assert.equal(await client.getExistingSessionControlStatus(), null)
    assert.equal(statusRequests, 2)
    assert.equal(target.sessions.activeCount(), 1)
    assert.equal(client.isAvailable(), true)
})

test("control status parser accepts legacy core fields and discards malformed diagnostics", () => {
    const legacy = {
        activeNodeSessions: 2,
        enabledCredentials: 3,
    }
    assert.deepEqual(parseHubControlStatus(legacy), legacy)
    assert.equal(isHubControlStatus(legacy), true)

    const malformedExtension = {
        ...legacy,
        activeRooms: 9,
        activeBattleFacts: "invalid",
        finalizedBattleFacts: 4,
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM",
            differences: [{ field: "RES_VER", different: true, raw: "secret" }],
            timestamp: "2026-08-06T00:00:00.000Z",
        },
    }
    assert.deepEqual(parseHubControlStatus(malformedExtension), legacy)
    assert.equal(isHubControlStatus(malformedExtension), true)
})

test("control status selects diagnostic fields and drops provider extras", async t => {
    const target = fixture(t, {
        getDiagnostics: () => ({
            activeRooms: 1,
            activeBattleFacts: 2,
            finalizedBattleFacts: 3,
            latestCompatibilityRejection: {
                code: "INCOMPATIBLE_ROOM",
                differences: [
                    {
                        field: "RES_VER",
                        different: true,
                        required: "1.4.54",
                        received: "1.4.55",
                        token: "nested-token",
                        sessionCredential: "nested-session",
                        credentialId: "nested-credential",
                        path: path.join(privateHomePrefix, "example", "nested.json"),
                        raw: { body: "nested-body" },
                        stack: "nested-stack",
                    },
                    {
                        field: "contentDigest",
                        different: true,
                        required: `sha256:${"a".repeat(64)}`,
                        received: `sha256:${"b".repeat(64)}`,
                    },
                    {
                        field: "APP_VER",
                        different: true,
                        required: "sha1-deadbeefdeadbeef",
                        received: "abcd-0123456789abcdef",
                    },
                    {
                        field: "cdnTargetVersion",
                        different: true,
                        required: "deadbeefdeadbeefdeadbeefdeadbeef",
                        received: path.join(privateHomePrefix, "version"),
                    },
                    {
                        field: "APP_VER",
                        different: true,
                        required: "1.8.1 beta",
                        received: "1.8.1\n",
                    },
                    {
                        field: "RES_VER",
                        different: true,
                        required: `1.4.54-${"a".repeat(40)}`,
                        received: "1.4.54\0",
                    },
                ],
                timestamp: "2026-08-06T00:00:00.000Z",
                token: "summary-token",
                raw: { body: "summary-body" },
            },
            token: "must-not-leak",
            credentialsPath: path.join(privateHomePrefix, "example", "private.json"),
            viewerId: 101,
            rawBody: { private: true },
            stack: "private stack",
        }),
    })
    const registration = await register(target.app, target.first.token)
    const response = await target.app.inject({
        method: "GET",
        url: "/v1/multi/status",
        headers: sessionHeaders(registration),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().value, {
        activeNodeSessions: 1,
        enabledCredentials: 2,
        tcpAvailable: true,
        activeRooms: 1,
        activeBattleFacts: 2,
        finalizedBattleFacts: 3,
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM",
            differences: [
                {
                    field: "RES_VER",
                    different: true,
                    required: "1.4.54",
                    received: "1.4.55",
                },
                { field: "contentDigest", different: true },
                { field: "APP_VER", different: true },
                { field: "cdnTargetVersion", different: true },
                { field: "APP_VER", different: true },
                { field: "RES_VER", different: true },
            ],
            timestamp: "2026-08-06T00:00:00.000Z",
        },
    })
    assert.equal(response.body.includes(privateHomePrefix), false)
    assert.doesNotMatch(response.body, /token|sessionCredential|credentialId|credentialsPath|viewerId|rawBody|raw|stack|sha256|sha1|deadbeef|0123456789abcdef|a{16}|b{16}/i)
})

test("control status response validator allows only dotted numeric diagnostic versions", () => {
    const core = {
        activeNodeSessions: 1,
        enabledCredentials: 1,
    }
    const status = difference => ({
        ...core,
        activeRooms: 1,
        activeBattleFacts: 1,
        finalizedBattleFacts: 1,
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM",
            differences: [difference],
            timestamp: "2026-08-06T00:00:00.000Z",
        },
    })
    for (const value of ["1.8.1", "1.4.54", "2.1.125-rc.1", "2.1.125-rc-2"]) {
        const input = status({
            field: "APP_VER",
            different: true,
            required: value,
            received: value,
        })
        assert.equal(isHubControlStatus(input), true, value)
        assert.deepEqual(parseHubControlStatus(input), input, value)
    }
    for (const value of [
        "sha1-deadbeefdeadbeef",
        "abcd-0123456789abcdef",
        "deadbeefdeadbeefdeadbeefdeadbeef",
        path.join(privateHomePrefix, "version"),
        "1.8.1 beta",
        "1.8.1\n",
        "1.8.1\0",
        `1.8.1-${"a".repeat(40)}`,
        "",
    ]) {
        const input = status({
            field: "APP_VER",
            different: true,
            required: value,
            received: "1.8.1",
        })
        assert.equal(isHubControlStatus(input), true, JSON.stringify(value))
        assert.deepEqual(parseHubControlStatus(input), core, JSON.stringify(value))
    }
})

test("status counting does not revalidate unrelated node credentials", () => {
    const generated = [
        "node-a", "a".repeat(43),
        "node-b", "b".repeat(43),
    ]
    let generatedIndex = 0
    let credentialChecks = 0
    const sessions = new NodeSessionRegistry({
        generateId: () => generated[generatedIndex++],
        isCredentialEnabled() {
            credentialChecks++
            return true
        },
    })
    const first = sessions.register("credential-a", MULTI_PROTOCOL_VERSION)
    sessions.register("credential-b", MULTI_PROTOCOL_VERSION)
    credentialChecks = 0

    assert.ok(sessions.authenticate(first.nodeSessionId, first.sessionCredential))
    assert.equal(credentialChecks, 1)
    assert.equal(sessions.activeCount(), 2)
    assert.equal(credentialChecks, 1)
})

test("real RemoteCoordinator retains finalized facts across room reset and session rotation", async t => {
    const target = fixture(t, { coordinatorFactory: createTrackedEmbeddedCoordinator })
    const hostClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const guestClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.second.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const hostCoordinator = new RemoteMultiCoordinator(hostClient)
    const guestCoordinator = new RemoteMultiCoordinator(guestClient)
    const created = await hostCoordinator.createRoom({
        requestId: "remote-finalized-lifecycle",
        participant: { nodeSessionId: "pending", viewerId: 101 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const roomNumber = created.value.roomNumber
    t.after(() => disbandRoom(roomNumber))
    const guestRoom = await guestCoordinator.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 202 },
        roomNumber,
    })
    assert.equal(guestRoom.ok, true)
    const guestParticipant = {
        nodeSessionId: guestClient.getNodeSessionId(),
        viewerId: 202,
    }
    assert.equal(addRoomMember(roomNumber, guestParticipant), true)
    const hostParticipant = created.value.host
    const guestSessionClient = sessionManager.createClient({
        writable: false,
        end() {},
    }, guestParticipant.viewerId, roomNumber, "remote-guest-lobby")
    guestSessionClient.participant = guestParticipant
    assert.equal(sessionManager.addClientToRoom(guestSessionClient).ok, true)
    t.after(() => sessionManager.removeClient(guestSessionClient))
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: "remote-host", participant: hostParticipant },
        { connectionId: "remote-guest", participant: guestParticipant },
    ], hostParticipant)

    const hostBattle = await hostCoordinator.startBattle({ participant: hostParticipant, roomNumber, compatibility })
    const guestBattle = await guestCoordinator.startBattle({ participant: guestParticipant, roomNumber, compatibility })
    assert.equal(hostBattle.ok, true)
    assert.equal(guestBattle.ok, true)
    assert.equal(hostBattle.value.battleSessionId, guestBattle.value.battleSessionId)
    const battleSessionId = hostBattle.value.battleSessionId
    sessionManager.markParticipantFinalizedBattle(roomNumber, hostParticipant)
    sessionManager.markParticipantFinalizedBattle(roomNumber, guestParticipant)

    assert.deepEqual(await hostCoordinator.startBattle({ participant: hostParticipant, roomNumber, compatibility }), {
        ok: false,
        error: "ROOM_NOT_FOUND",
    })
    assert.deepEqual(await guestCoordinator.startBattle({ participant: guestParticipant, roomNumber, compatibility }), {
        ok: false,
        error: "ROOM_NOT_FOUND",
    })
    const finalized = await hostCoordinator.finalizeBattle({
        participant: hostParticipant,
        roomNumber,
        battleSessionId,
    })
    assert.equal(finalized.ok, true)
    assert.equal(finalized.value.finalized, true)
    assert.equal(getRoom(roomNumber).raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), null)

    const rotatedClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const rotated = new RemoteMultiCoordinator(rotatedClient)
    const delayed = await rotated.getBattleStatus({
        participant: { nodeSessionId: "pending", viewerId: 101 },
        roomNumber,
        battleSessionId,
    })
    assert.equal(delayed.ok, true)
    assert.equal(delayed.value.finalized, true)
    assert.equal(delayed.value.host.nodeSessionId, rotatedClient.getNodeSessionId())
    assert.equal("credentialId" in delayed.value, false)

    assert.deepEqual(await guestCoordinator.getBattleStatus({
        participant: guestParticipant,
        roomNumber,
        battleSessionId,
    }), { ok: true, value: {
        ...guestBattle.value,
        host: delayed.value.host,
        participants: delayed.value.participants,
        finalized: true,
    } })
    assert.deepEqual(await guestCoordinator.getBattleStatus({
        participant: { nodeSessionId: "pending", viewerId: 101 },
        roomNumber,
        battleSessionId,
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })

    target.store.revoke(target.first.credentialId)
    target.reloader.reloadIfChanged()
    assert.deepEqual(await rotated.getBattleStatus({
        participant: { nodeSessionId: "pending", viewerId: 101 },
        roomNumber,
        battleSessionId,
    }), { ok: false, error: "HUB_UNAVAILABLE" })
})

test("real RemoteCoordinator removes an aborted guest before host finalization", async t => {
    const target = fixture(t, { coordinatorFactory: createTrackedEmbeddedCoordinator })
    const hostClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const guestClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.second.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const hostRemote = new RemoteMultiCoordinator(hostClient)
    const guestRemote = new RemoteMultiCoordinator(guestClient)
    const created = await hostRemote.createRoom({
        requestId: "remote-abort",
        participant: { nodeSessionId: "pending", viewerId: 303 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const roomNumber = created.value.roomNumber
    t.after(() => disbandRoom(roomNumber))
    assert.equal((await guestRemote.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 404 },
        roomNumber,
    })).ok, true)
    const guestParticipant = {
        nodeSessionId: guestClient.getNodeSessionId(),
        viewerId: 404,
    }
    assert.equal(addRoomMember(roomNumber, guestParticipant), true)
    const guestSessionClient = sessionManager.createClient({
        writable: false,
        end() {},
    }, guestParticipant.viewerId, roomNumber, "remote-abort-guest-lobby")
    guestSessionClient.participant = guestParticipant
    assert.equal(sessionManager.addClientToRoom(guestSessionClient).ok, true)
    t.after(() => sessionManager.removeClient(guestSessionClient))
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: "remote-abort-host", participant: created.value.host },
        { connectionId: "remote-abort-guest", participant: guestParticipant },
    ], created.value.host)
    const hostBattle = await hostRemote.startBattle({
        participant: created.value.host,
        roomNumber,
        compatibility,
    })
    const guestBattle = await guestRemote.startBattle({
        participant: guestParticipant,
        roomNumber,
        compatibility,
    })
    assert.equal(hostBattle.ok, true)
    assert.equal(guestBattle.ok, true)

    assert.deepEqual(await guestRemote.abortBattle({
        participant: guestParticipant,
        roomNumber,
    }), { ok: true, value: undefined })
    assert.deepEqual(await guestRemote.abortBattle({
        participant: guestParticipant,
        roomNumber,
    }), { ok: true, value: undefined })
    assert.notEqual(getRoom(roomNumber), undefined)
    assert.equal(sessionManager.getBattleParticipant(roomNumber, "remote-abort-guest"), undefined)
    assert.notEqual(sessionManager.getBattleParticipant(roomNumber, "remote-abort-host"), undefined)
    assert.deepEqual(await guestRemote.getBattleStatus({
        participant: guestParticipant,
        roomNumber,
        battleSessionId: guestBattle.value.battleSessionId,
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })

    sessionManager.markParticipantFinalizedBattle(roomNumber, created.value.host)
    const finalized = await hostRemote.finalizeBattle({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })
    assert.equal(finalized.ok, true)
    assert.equal(finalized.value.finalized, true)
    assert.equal(getRoom(roomNumber).raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), null)
    assert.equal((await hostRemote.getBattleStatus({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })).ok, true)
})

test("real RemoteCoordinator releases after a finalized host loses its guest", async t => {
    const target = fixture(t, { coordinatorFactory: createTrackedEmbeddedCoordinator })
    const hostClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const guestClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.second.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    })
    const hostRemote = new RemoteMultiCoordinator(hostClient)
    const guestRemote = new RemoteMultiCoordinator(guestClient)
    const created = await hostRemote.createRoom({
        requestId: "remote-host-finalize-before-guest-abort",
        participant: { nodeSessionId: "pending", viewerId: 404 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const roomNumber = created.value.roomNumber
    t.after(() => disbandRoom(roomNumber))
    assert.equal((await guestRemote.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 405 },
        roomNumber,
    })).ok, true)
    const guestParticipant = {
        nodeSessionId: guestClient.getNodeSessionId(),
        viewerId: 405,
    }
    assert.equal(addRoomMember(roomNumber, guestParticipant), true)
    const guestSessionClient = sessionManager.createClient({
        writable: false,
        end() {},
    }, guestParticipant.viewerId, roomNumber, "guest-late-abort-lobby")
    guestSessionClient.participant = guestParticipant
    assert.equal(sessionManager.addClientToRoom(guestSessionClient).ok, true)
    t.after(() => sessionManager.removeClient(guestSessionClient))
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: "host-first-finalize", participant: created.value.host },
        { connectionId: "guest-late-abort", participant: guestParticipant },
    ], created.value.host)
    updateRoomState(roomNumber, 4)
    const hostBattle = await hostRemote.startBattle({
        participant: created.value.host,
        roomNumber,
        compatibility,
    })
    const guestBattle = await guestRemote.startBattle({
        participant: guestParticipant,
        roomNumber,
        compatibility,
    })
    assert.equal(hostBattle.ok, true)
    assert.equal(guestBattle.ok, true)

    sessionManager.markParticipantFinalizedBattle(roomNumber, created.value.host)
    const hostFinalized = await hostRemote.finalizeBattle({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })
    assert.equal(hostFinalized.ok, true)
    assert.equal(hostFinalized.value.finalized, true)
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), hostBattle.value.battleSessionId)

    assert.deepEqual(await guestRemote.abortBattle({
        participant: guestParticipant,
        roomNumber,
    }), { ok: true, value: undefined })
    assert.equal(getRoom(roomNumber).raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), null)
    assert.equal((await hostRemote.getBattleStatus({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })).ok, true)
    assert.deepEqual(await guestRemote.getBattleStatus({
        participant: guestParticipant,
        roomNumber,
        battleSessionId: guestBattle.value.battleSessionId,
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })
})

test("lost remote guest abort converges after its active session becomes idle", async t => {
    const target = fixture(t, {
        coordinatorFactory: createTrackedEmbeddedCoordinator,
        sessionTtlMs: 100,
    })
    const throughHub = fetchThroughHub(target.app)
    const guestClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.second.token,
        fetch: async (url, init) => {
            if (new URL(url).pathname === "/v1/multi/battles/abort") {
                throw new Error("injected lost abort request")
            }
            return throughHub(url, init)
        },
        now: () => target.getNow(),
    })
    const guestRemote = new RemoteMultiCoordinator(guestClient)
    assert.deepEqual(await guestRemote.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 607 },
        roomNumber: "000000",
    }), { ok: false, error: "ROOM_NOT_FOUND" })
    const guestNodeSessionId = guestClient.getNodeSessionId()

    target.setNow(10_050)
    const hostClient = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: throughHub,
        now: () => target.getNow(),
    })
    const hostRemote = new RemoteMultiCoordinator(hostClient)
    const created = await hostRemote.createRoom({
        requestId: "lost-remote-guest-abort",
        participant: { nodeSessionId: "pending", viewerId: 606 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const roomNumber = created.value.roomNumber
    t.after(() => disbandRoom(roomNumber))
    const guestParticipant = { nodeSessionId: guestNodeSessionId, viewerId: 607 }
    assert.equal(addRoomMember(roomNumber, guestParticipant), true)
    const guestSessionClient = sessionManager.createClient({
        writable: false,
        end() {},
    }, guestParticipant.viewerId, roomNumber, "lost-abort-guest-lobby")
    guestSessionClient.participant = guestParticipant
    assert.equal(sessionManager.addClientToRoom(guestSessionClient).ok, true)
    t.after(() => sessionManager.removeClient(guestSessionClient))
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: "lost-abort-host", participant: created.value.host },
        { connectionId: "lost-abort-guest", participant: guestParticipant },
    ], created.value.host)
    updateRoomState(roomNumber, 4)
    const hostBattle = await hostRemote.startBattle({
        participant: created.value.host,
        roomNumber,
        compatibility,
    })
    const guestBattle = await guestRemote.startBattle({
        participant: guestParticipant,
        roomNumber,
        compatibility,
    })
    assert.equal(hostBattle.ok, true)
    assert.equal(guestBattle.ok, true)
    target.setNow(10_075)
    sessionManager.markParticipantFinalizedBattle(roomNumber, created.value.host)
    assert.equal((await hostRemote.finalizeBattle({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })).ok, true)

    assert.deepEqual(await guestRemote.abortBattle({
        participant: guestParticipant,
        roomNumber,
    }), { ok: false, error: "HUB_UNAVAILABLE" })
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), hostBattle.value.battleSessionId)

    target.setNow(10_151)
    assert.equal(target.sessions.sweep(), 1)
    assert.equal(getRoom(roomNumber).raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(roomNumber), null)
    assert.equal((await hostRemote.getBattleStatus({
        participant: created.value.host,
        roomNumber,
        battleSessionId: hostBattle.value.battleSessionId,
    })).ok, true)
    assert.deepEqual(await guestRemote.getBattleStatus({
        participant: { nodeSessionId: "pending", viewerId: guestParticipant.viewerId },
        roomNumber,
        battleSessionId: guestBattle.value.battleSessionId,
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })
})

test("real RemoteCoordinator treats repeated host abort as idempotent", async t => {
    const target = fixture(t, { coordinatorFactory: createTrackedEmbeddedCoordinator })
    const remote = new RemoteMultiCoordinator(new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: target.first.token,
        fetch: fetchThroughHub(target.app),
        now: () => target.getNow(),
    }))
    const created = await remote.createRoom({
        requestId: "remote-host-abort-idempotent",
        participant: { nodeSessionId: "pending", viewerId: 505 },
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const input = { participant: created.value.host, roomNumber: created.value.roomNumber }

    assert.deepEqual(await remote.abortBattle(input), { ok: true, value: undefined })
    assert.equal(getRoom(created.value.roomNumber), undefined)
    assert.deepEqual(await remote.abortBattle(input), { ok: true, value: undefined })
})
