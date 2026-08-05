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
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")
const { HubClient } = require("../src/multi/hub/client")
const { IdempotencyCache } = require("../src/multi/hub/idempotency")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")
const { buildMultiHubControlApp } = require("../src/multi/hub/server")
const { addRoomMember, disbandRoom, getRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")

const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

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
    let randomIndex = 0
    const randomValues = [
        "node-session-a", "session-credential-a".padEnd(43, "a"),
        "node-session-b", "session-credential-b".padEnd(43, "b"),
        "node-session-c", "session-credential-c".padEnd(43, "c"),
    ]
    const admissions = new AdmissionRegistry({ now: () => now })
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
        nodeSessions: sessions,
        admissionIssuer: admissions,
        idempotency,
        tcpEndpoint: { host: "hub.internal", port: 8003 },
    })
    t.after(() => app.close())
    return {
        admissions,
        app,
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

test("rejects malformed, unknown, revoked and incompatible registration credentials", async t => {
    const target = fixture(t)

    for (const [token, protocolVersion] of [
        ["short", MULTI_PROTOCOL_VERSION],
        ["z".repeat(64), MULTI_PROTOCOL_VERSION],
        [target.first.token, MULTI_PROTOCOL_VERSION + 1],
    ]) {
        const response = await register(target.app, token, protocolVersion)
        assert.equal(response.statusCode, 401)
        assert.deepEqual(response.json(), { ok: false, code: "UNAUTHORIZED" })
        assert.equal(response.body.includes(token), false)
    }

    target.store.revoke(target.first.credentialId)
    target.reloader.reloadIfChanged()
    const revoked = await register(target.app, target.first.token)
    assert.equal(revoked.statusCode, 401)
    assert.deepEqual(revoked.json(), { ok: false, code: "UNAUTHORIZED" })
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
        "activeNodeSessions",
        "enabledCredentials",
    ])
    assert.equal(status.body.includes(target.first.label), false)
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
    assert.equal(addRoomMember(roomNumber, 202), true)
    const guestRoom = await guestCoordinator.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 202 },
        roomNumber,
    })
    assert.equal(guestRoom.ok, true)
    const hostParticipant = created.value.host
    const guestParticipant = {
        nodeSessionId: guestClient.getNodeSessionId(),
        viewerId: 202,
    }
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

    const hostBattle = await hostCoordinator.startBattle({ participant: hostParticipant, roomNumber })
    const guestBattle = await guestCoordinator.startBattle({ participant: guestParticipant, roomNumber })
    assert.equal(hostBattle.ok, true)
    assert.equal(guestBattle.ok, true)
    assert.equal(hostBattle.value.battleSessionId, guestBattle.value.battleSessionId)
    const battleSessionId = hostBattle.value.battleSessionId
    sessionManager.markParticipantFinalizedBattle(roomNumber, hostParticipant)
    sessionManager.markParticipantFinalizedBattle(roomNumber, guestParticipant)

    assert.deepEqual(await hostCoordinator.startBattle({ participant: hostParticipant, roomNumber }), {
        ok: false,
        error: "ROOM_NOT_FOUND",
    })
    assert.deepEqual(await guestCoordinator.startBattle({ participant: guestParticipant, roomNumber }), {
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

test("real RemoteCoordinator aborts through Hub room ownership", async t => {
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
    assert.equal(addRoomMember(roomNumber, 404), true)
    assert.equal((await guestRemote.getRoomStatus({
        participant: { nodeSessionId: "pending", viewerId: 404 },
        roomNumber,
    })).ok, true)
    const guestParticipant = {
        nodeSessionId: guestClient.getNodeSessionId(),
        viewerId: 404,
    }
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

    assert.deepEqual(await guestRemote.abortBattle({
        participant: guestParticipant,
        roomNumber,
    }), { ok: true, value: undefined })
    assert.notEqual(getRoom(roomNumber), undefined)
    assert.equal(sessionManager.getBattleParticipant(roomNumber, "remote-abort-guest"), undefined)
    assert.notEqual(sessionManager.getBattleParticipant(roomNumber, "remote-abort-host"), undefined)

    assert.deepEqual(await hostRemote.abortBattle({
        participant: created.value.host,
        roomNumber,
    }), { ok: true, value: undefined })
    assert.equal(getRoom(roomNumber), undefined)
})
