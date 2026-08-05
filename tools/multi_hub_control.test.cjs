"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")
const { IdempotencyCache } = require("../src/multi/hub/idempotency")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")
const { buildMultiHubControlApp } = require("../src/multi/hub/server")

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
        if (name === "disbandRoom") return { ok: true, value: undefined }
        if (name.includes("Battle")) {
            return {
                ok: true,
                value: {
                    battleSessionId: input.battleSessionId ?? "battle-session",
                    roomNumber: input.roomNumber ?? "123456",
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
            startBattle: invoke("startBattle"),
            finalizeBattle: invoke("finalizeBattle"),
            getBattleStatus: invoke("getBattleStatus"),
            getRoomStatus: invoke("getRoomStatus"),
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
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: options.sessionTtlMs ?? 5_000,
        generateId: () => randomValues[randomIndex++],
        isCredentialEnabled: credentialId => reloader.isCredentialEnabled(credentialId),
        onInvalidated: nodeSessionId => admissions.removeByNodeSession(nodeSessionId),
    })
    const coordinator = createCoordinator()
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
        ["/v1/multi/battles/finalize", "finalizeBattle", { participant, battleSessionId: "battle-session" }, true],
        ["/v1/multi/battles/status", "getBattleStatus", { participant, battleSessionId: "battle-session" }, false],
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

test("requires bounded ASCII idempotency keys and isolates cached writes by node and TTL", async t => {
    const target = fixture(t, { idempotencyTtlMs: 100 })
    const first = await register(target.app, target.first.token)
    const second = await register(target.app, target.second.token)
    const payload = {
        ...participantInput(first),
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
            headers: sessionHeaders(first, key),
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
    const firstResult = await invoke(first)
    const replay = await invoke(first)
    assert.equal(firstResult.body, replay.body)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 1)

    await invoke(second)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 2)

    target.setNow(10_101)
    await invoke(first)
    assert.equal(target.coordinator.calls.filter(([name]) => name === "createRoom").length, 3)
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
