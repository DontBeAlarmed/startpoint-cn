"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const Fastify = require("fastify")
const path = require("node:path")
const { pack, unpack } = require("msgpackr")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { HubClient } = require("../src/multi/hub/client")
const { RemoteMultiCoordinator } = require("../src/multi/coordinator/remote")
const { serializeRoomStatusConnection } = require("../src/multi/room/serializer")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { registerSocialRoutes } = require("../src/multi/http/social")

const ROOT = path.resolve(__dirname, "..")
const TOKEN = "a".repeat(32)
const compatibility = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "1.8.1",
    RES_VER: "1.4.54",
    cdnTargetVersion: "1.4.54",
    contentDigest: `sha256:${"1".repeat(64)}`,
    modeDigest: `sha256:${"2".repeat(64)}`,
})

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    })
}

function registration(id = "node-a") {
    return {
        nodeSessionId: id,
        sessionCredential: "s".repeat(43),
        expiresAt: Date.now() + 60_000,
        tcp: { host: "hub.example", port: 8003 },
    }
}

function roomStatus(nodeSessionId = "node-a") {
    return {
        roomNumber: "123456",
        accessToken: "access-token",
        category: 1,
        questId: 701,
        hostEntryTime: 1_725_000_000,
        roomSequence: 1,
        raisingState: 2,
        shareRoomOptions: 0,
        hostMainCharacterId: 401,
        isNpcMode: false,
        hostOnline: true,
        host: { nodeSessionId, viewerId: 101 },
        members: [{ nodeSessionId, viewerId: 101 }],
        compatibility,
    }
}

function participant(viewerId = 101) {
    return { nodeSessionId: "pending", viewerId }
}

function battleStatus(nodeSessionId = "node-a") {
    return {
        battleSessionId: "battle-1",
        roomNumber: "123456",
        participants: [{ nodeSessionId, viewerId: 101 }],
        finalized: false,
    }
}

function playerSnapshot(viewerId = 101) {
    const character = [0, {
        id: 401,
        evolution_level: 0,
        exp: 0,
        over_limit_step: 0,
        mana_node_ids: { "1": 0 },
        ex_boost: [0, { ability_id_list: [11], status_id: 7 }],
        illustration_settings: [1],
    }]
    const party = {
        characters: [character, [1], [1]],
        unison_characters: [[1], [1], [1]],
        equipments: [[0, { equipmentId: 501, level: 1, enhancementLevel: 0 }], [1], [1]],
        abilitySoulIds: [[0, 601], [1], [1]],
    }
    return {
        viewerId,
        name: `Player${viewerId}`,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 401,
        playerRoleKind: 1,
        isNewbie: false,
        currentPartyId: 1,
        party,
        npcParties: [party],
    }
}

function admission(nodeSessionId = "node-a") {
    return {
        roomNumber: "123456",
        participant: { nodeSessionId, viewerId: 101 },
        snapshot: playerSnapshot(),
        expiresAt: Date.now() + 10_000,
    }
}

test("Hub client registers lazily and sends the registered participant identity", async () => {
    const calls = []
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async (url, init) => {
            calls.push({ url: String(url), init, body: JSON.parse(init.body) })
            if (String(url).endsWith("/nodes/register")) return jsonResponse(registration())
            return jsonResponse({ ok: true, value: roomStatus() })
        },
    })

    assert.equal(calls.length, 0)
    const result = await client.read("/v1/multi/rooms/status", {
        participant: participant(),
        roomNumber: "123456",
    })

    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].body.participant.nodeSessionId, "node-a")
    assert.equal(calls[1].init.headers.authorization, `Bearer ${"s".repeat(43)}`)
    assert.deepEqual(client.getTcpEndpoint(), { host: "hub.example", port: 8003 })
})

test("Hub client bounds timeout and JSON response size", async t => {
    await t.test("timeout", async () => {
        let calls = 0
        const client = new HubClient({
            hubUrl: new URL("http://hub.example/"),
            token: TOKEN,
            timeoutMs: 10,
            fetch: async (_url, init) => {
                calls++
                if (calls === 1) return jsonResponse(registration())
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
                })
            },
        })
        const result = await client.read("/v1/multi/rooms/status", {
            participant: participant(), roomNumber: "123456",
        })
        assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
        assert.equal(calls, 3, "one bounded read retry")
    })

    await t.test("response size", async () => {
        let calls = 0
        const client = new HubClient({
            hubUrl: new URL("http://hub.example/"),
            token: TOKEN,
            maxResponseBytes: 256,
            fetch: async url => {
                calls++
                return String(url).endsWith("/nodes/register")
                    ? jsonResponse(registration())
                    : jsonResponse({ ok: true, value: "x".repeat(1_024) })
            },
        })
        const result = await client.read("/v1/multi/rooms/status", {
            participant: participant(), roomNumber: "123456",
        })
        assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
        assert.equal(calls, 3, "registration plus one bounded operation retry")
    })
})

test("Hub client retries a bounded read once", async () => {
    let operationCalls = 0
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async url => {
            if (String(url).endsWith("/nodes/register")) return jsonResponse(registration())
            operationCalls++
            if (operationCalls === 1) throw new TypeError("temporary network failure")
            return jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" })
        },
    })
    assert.deepEqual(await client.read("/v1/multi/rooms/status", {
        participant: participant(), roomNumber: "123456",
    }), { ok: false, error: "ROOM_NOT_FOUND" })
    assert.equal(operationCalls, 2)
})

test("Hub client reuses the same idempotency key when retrying a write", async () => {
    const keys = []
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        createIdempotencyKey: () => "stable-write-key",
        fetch: async (url, init) => {
            if (String(url).endsWith("/nodes/register")) return jsonResponse(registration())
            keys.push(init.headers["x-idempotency-key"])
            if (keys.length === 1) throw new TypeError("connection reset")
            return jsonResponse({ ok: true, value: roomStatus() })
        },
    })
    const result = await client.write("/v1/multi/rooms/create", {
        requestId: "create-1",
        participant: participant(),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(keys, ["stable-write-key", "stable-write-key"])
})

test("Hub client refreshes an expired session only once", async () => {
    let registrations = 0
    let operations = 0
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async url => {
            if (String(url).endsWith("/nodes/register")) {
                registrations++
                return jsonResponse(registration(`node-${registrations}`))
            }
            operations++
            return jsonResponse({ ok: false, code: "UNAUTHORIZED" }, 401)
        },
    })
    assert.deepEqual(await client.read("/v1/multi/rooms/status", {
        participant: participant(), roomNumber: "123456",
    }), { ok: false, error: "HUB_UNAVAILABLE" })
    assert.equal(registrations, 2)
    assert.equal(operations, 2)
})

test("Hub client rejects malformed successful values for every operation shape", async t => {
    const cases = [
        ["room", "/v1/multi/rooms/status", { ...roomStatus(), host: null }],
        ["battle", "/v1/multi/battles/status", {
            ...battleStatus(), participants: [{ nodeSessionId: "node-a", viewerId: 0 }],
        }],
        ["admission", "/v1/multi/admissions/issue", {
            ...admission(), snapshot: { viewerId: 101 },
        }],
    ]
    for (const [label, route, value] of cases) {
        await t.test(label, async () => {
            const client = new HubClient({
                hubUrl: new URL("http://hub.example/"),
                token: TOKEN,
                fetch: async url => String(url).endsWith("/nodes/register")
                    ? jsonResponse(registration())
                    : jsonResponse({ ok: true, value }),
            })
            const result = route.includes("admissions")
                ? await client.write(route, { participant: participant() })
                : await client.read(route, { participant: participant() })
            assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
            assert.equal(client.isAvailable(), false)
        })
    }

    await t.test("registration TCP endpoint", async () => {
        const client = new HubClient({
            hubUrl: new URL("http://hub.example/"),
            token: TOKEN,
            fetch: async () => jsonResponse({ ...registration(), tcp: { host: "", port: 0 } }),
        })
        assert.deepEqual(await client.read("/v1/multi/rooms/status", {
            participant: participant(), roomNumber: "123456",
        }), { ok: false, error: "HUB_UNAVAILABLE" })
        assert.equal(client.getTcpEndpoint(), null)
        assert.equal(client.isAvailable(), false)
    })

    await t.test("already expired registration", async () => {
        const paths = []
        const client = new HubClient({
            hubUrl: new URL("http://hub.example/"),
            token: TOKEN,
            now: () => 100,
            fetch: async url => {
                paths.push(new URL(url).pathname)
                return jsonResponse({ ...registration(), expiresAt: 100 })
            },
        })
        assert.deepEqual(await client.read("/v1/multi/rooms/status", {
            participant: participant(), roomNumber: "123456",
        }), { ok: false, error: "HUB_UNAVAILABLE" })
        assert.deepEqual(paths, ["/v1/multi/nodes/register"])
        assert.equal(client.getNodeSessionId(), null)
        assert.equal(client.isAvailable(), false)
    })
})

test("Hub client accepts validated room, battle, admission and void successes", async () => {
    const values = new Map([
        ["/v1/multi/rooms/status", roomStatus()],
        ["/v1/multi/battles/status", battleStatus()],
        ["/v1/multi/admissions/issue", admission()],
        ["/v1/multi/rooms/disband", undefined],
    ])
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async url => {
            const route = new URL(url).pathname
            if (route.endsWith("/nodes/register")) return jsonResponse(registration())
            const value = values.get(route)
            return jsonResponse(value === undefined
                ? { ok: true }
                : { ok: true, value })
        },
    })
    assert.equal((await client.read("/v1/multi/rooms/status", {})).ok, true)
    assert.equal((await client.read("/v1/multi/battles/status", {})).ok, true)
    assert.equal((await client.write("/v1/multi/admissions/issue", {})).ok, true)
    assert.deepEqual(await client.write("/v1/multi/rooms/disband", {}), {
        ok: true, value: undefined,
    })
})

test("an uncertain write never crosses node sessions after retry", async () => {
    let registrations = 0
    const operationNodes = []
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async (url, init) => {
            if (String(url).endsWith("/nodes/register")) {
                registrations++
                return jsonResponse(registration(`node-${registrations}`))
            }
            operationNodes.push(init.headers["x-node-session-id"])
            if (operationNodes.length === 1) throw new TypeError("connection reset")
            if (operationNodes.length === 2) {
                return jsonResponse({ ok: false, code: "UNAUTHORIZED" }, 401)
            }
            return jsonResponse({ ok: true, value: roomStatus(`node-${registrations}`) })
        },
    })
    assert.deepEqual(await client.write("/v1/multi/rooms/create", {
        participant: participant(),
    }), { ok: false, error: "HUB_UNAVAILABLE" })
    assert.equal(registrations, 1)
    assert.deepEqual(operationNodes, ["node-1", "node-1"])
    assert.equal(client.getNodeSessionId(), null)
})

test("a first definite 401 refreshes reads and writes only once", async t => {
    for (const kind of ["read", "write"]) {
        await t.test(kind, async () => {
            let registrations = 0
            const operationNodes = []
            const client = new HubClient({
                hubUrl: new URL("http://hub.example/"),
                token: TOKEN,
                fetch: async (url, init) => {
                    if (String(url).endsWith("/nodes/register")) {
                        registrations++
                        return jsonResponse(registration(`node-${registrations}`))
                    }
                    operationNodes.push(init.headers["x-node-session-id"])
                    return operationNodes.length === 1
                        ? jsonResponse({ ok: false, code: "UNAUTHORIZED" }, 401)
                        : jsonResponse({ ok: true, value: roomStatus("node-2") })
                },
            })
            const result = await client[kind](
                kind === "read" ? "/v1/multi/rooms/status" : "/v1/multi/rooms/create",
                { participant: participant() },
            )
            assert.equal(result.ok, true)
            assert.equal(registrations, 2)
            assert.deepEqual(operationNodes, ["node-1", "node-2"])
        })
    }
})

test("a write gets only one transport attempt after a definite 401 refresh", async () => {
    let registrations = 0
    const operationNodes = []
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async (url, init) => {
            if (String(url).endsWith("/nodes/register")) {
                registrations++
                return jsonResponse(registration(`node-${registrations}`))
            }
            operationNodes.push(init.headers["x-node-session-id"])
            if (operationNodes.length === 1) {
                return jsonResponse({ ok: false, code: "UNAUTHORIZED" }, 401)
            }
            if (operationNodes.length === 2) throw new TypeError("connection reset")
            return jsonResponse({ ok: true, value: roomStatus("node-2") })
        },
    })
    assert.deepEqual(await client.write("/v1/multi/rooms/create", {
        participant: participant(),
    }), { ok: false, error: "HUB_UNAVAILABLE" })
    assert.deepEqual(operationNodes, ["node-1", "node-2"])
})

test("expired sessions stop exposing identity, TCP endpoint and availability", async () => {
    let now = 100
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        now: () => now,
        fetch: async url => String(url).endsWith("/nodes/register")
            ? jsonResponse({ ...registration(), expiresAt: 200 })
            : jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }),
    })
    await client.read("/v1/multi/rooms/status", {
        participant: participant(), roomNumber: "123456",
    })
    assert.equal(client.isAvailable(), true)
    assert.equal(client.getNodeSessionId(), "node-a")

    now = 200
    assert.equal(client.getNodeSessionId(), null)
    assert.equal(client.getTcpEndpoint(), null)
    assert.equal(client.isAvailable(), false)
})

test("malformed 200 and invalid 4xx responses degrade availability", async () => {
    const responses = [
        jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }),
        jsonResponse({ ok: true, value: { roomNumber: "partial" } }),
        jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400),
    ]
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async url => String(url).endsWith("/nodes/register")
            ? jsonResponse(registration())
            : responses.shift(),
    })
    const input = { participant: participant(), roomNumber: "123456" }
    assert.deepEqual(await client.read("/v1/multi/rooms/status", input), {
        ok: false, error: "ROOM_NOT_FOUND",
    })
    assert.equal(client.isAvailable(), true)
    assert.deepEqual(await client.read("/v1/multi/rooms/status", input), {
        ok: false, error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.isAvailable(), false)
    assert.deepEqual(await client.read("/v1/multi/rooms/status", input), {
        ok: false, error: "HUB_UNAVAILABLE",
    })
    assert.equal(client.isAvailable(), false)
})

test("client runtime degrades immediately when its Hub session expires", async () => {
    let now = 100
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        now: () => now,
        fetch: async url => String(url).endsWith("/nodes/register")
            ? jsonResponse({ ...registration(), expiresAt: 200 })
            : jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }),
    })
    const remote = new RemoteMultiCoordinator(client)
    const service = createMultiRuntimeService({
        startTcp: async () => {}, stopTcp: async () => {}, isTcpListening: () => false,
        startHub: async () => {}, stopHub: async () => {}, isHubListening: () => false,
        createRemoteCoordinator: () => remote,
    })
    await service.start({ mode: "client", hubUrl: new URL("http://hub.example/"), token: TOKEN })
    await remote.getRoomStatus({ participant: participant(), roomNumber: "123456" })
    assert.equal(service.getStatus().state, "ready")
    now = 200
    assert.deepEqual(service.getStatus(), {
        mode: "client",
        state: "degraded",
        coordinator: { kind: "remote", available: false },
        hub: { available: false, endpoint: "http://hub.example/" },
        tcp: { available: false, endpoint: null },
    })
    await service.stop()
})

test("Remote coordinator implements every Hub operation and forwards compatibility", async () => {
    const calls = []
    const client = {
        read: async (route, input) => {
            calls.push(["read", route, input])
            return { ok: false, error: "ROOM_NOT_FOUND" }
        },
        write: async (route, input, key) => {
            calls.push(["write", route, input, key])
            return { ok: false, error: "HUB_UNAVAILABLE" }
        },
        getTcpEndpoint: () => ({ host: "hub.example", port: 8003 }),
        getNodeSessionId: () => "node-a",
        isAvailable: () => true,
    }
    const remote = new RemoteMultiCoordinator(client)
    const compatible = { participant: participant(), roomNumber: "123456", compatibility }
    await remote.createRoom({
        requestId: "create-1", participant: participant(), localPlayerId: 9,
        partyId: 1, category: 1, questId: 701, leaderCharacterId: 401, compatibility,
    })
    await remote.searchRoom(compatible)
    await remote.prepareRoom(compatible)
    await remote.selectRoom(compatible)
    await remote.disbandRoom({ participant: participant(), roomNumber: "123456" })
    await remote.startBattle({ participant: participant(), roomNumber: "123456" })
    await remote.finalizeBattle({ participant: participant(), battleSessionId: "battle-1" })
    await remote.getBattleStatus({ participant: participant(), battleSessionId: "battle-1" })
    await remote.getRoomStatus({ participant: participant(), roomNumber: "123456" })
    await remote.issue({
        roomNumber: "123456",
        participant: participant(),
        snapshot: { viewerId: 101 },
        expiresAt: Date.now() + 10_000,
    })

    assert.deepEqual(calls.map(call => call.slice(0, 2)), [
        ["write", "/v1/multi/rooms/create"],
        ["read", "/v1/multi/rooms/search"],
        ["write", "/v1/multi/rooms/prepare"],
        ["read", "/v1/multi/rooms/select"],
        ["write", "/v1/multi/rooms/disband"],
        ["write", "/v1/multi/battles/start"],
        ["write", "/v1/multi/battles/finalize"],
        ["read", "/v1/multi/battles/status"],
        ["read", "/v1/multi/rooms/status"],
        ["write", "/v1/multi/admissions/issue"],
    ])
    assert.deepEqual(calls[1][2].compatibility, compatibility)
    assert.deepEqual(remote.getTcpEndpoint(), { host: "hub.example", port: 8003 })
})

test("serializer uses the Hub TCP endpoint without exposing an update URL", () => {
    const serialized = serializeRoomStatusConnection(
        roomStatus(),
        { host: "hub.example", port: 9103 },
    )
    assert.equal(serialized.ip_address, "hub.example")
    assert.equal(serialized.port, 9103)
    assert.equal(serialized.application_update_url, "")
    assert.equal("asset_update" in serialized, false)
})

test("multi HTTP routes do not introduce CDN update side effects", () => {
    const lobby = fs.readFileSync(path.join(ROOT, "src/multi/http/lobby.ts"), "utf8")
    const room = fs.readFileSync(path.join(ROOT, "src/multi/http/room.ts"), "utf8")
    const social = fs.readFileSync(path.join(ROOT, "src/multi/http/social.ts"), "utf8")
    const sources = `${lobby}\n${room}\n${social}`

    assert.doesNotMatch(sources, /asset_update\s*:\s*true/)
    assert.doesNotMatch(sources, /\/patch\/cn|CDN_BASE_URL|registerAssetRoutes/)
})

async function routeServer({ result, questAvailable = true } = {}) {
    let coordinatorResult = result ?? { ok: true, value: roomStatus() }
    const coordinator = {
        createRoom: async () => coordinatorResult,
        searchRoom: async () => coordinatorResult,
        prepareRoom: async () => coordinatorResult,
        selectRoom: async () => coordinatorResult,
        disbandRoom: async () => coordinatorResult,
        startBattle: async () => coordinatorResult,
        finalizeBattle: async () => coordinatorResult,
        getBattleStatus: async () => coordinatorResult,
        getRoomStatus: async () => coordinatorResult,
    }
    const app = Fastify()
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    const context = {
        coordinator,
        resolvePlayerContext: async viewerId => ({
            playerId: viewerId + 100,
            player: { name: `Player${viewerId}`, rankPoint: 0 },
        }),
        snapshotProvider: {
            getParticipant: participant,
            getCompatibility: () => ({ ok: true, value: compatibility }),
            prepareAdmission: async viewerId => ({
                snapshot: { viewerId },
            }),
        },
        questAvailability: {
            check: () => questAvailable
                ? { available: true }
                : { available: false, code: "QUEST_NOT_AVAILABLE" },
        },
        admissionProvider: {},
        admissionIssuer: { issue: async () => ({ ok: true, value: {} }) },
        admissionTtlMs: 5_000,
        now: () => 1_000,
        settlementVerifier: coordinator,
        tcpEndpoint: () => ({ host: "hub.example", port: 9103 }),
    }
    registerLobbyRoutes(app, context)
    registerRoomRoutes(app, context)
    registerSocialRoutes(app, context)
    await app.ready()
    return {
        app,
        setResult(value) { coordinatorResult = value },
    }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

test("each CN endpoint maps join failures without claiming the room is missing", async t => {
    const target = await routeServer()
    t.after(() => target.app.close())
    const joinErrors = [
        "INCOMPATIBLE_ROOM",
        "VIEWER_ID_CONFLICT",
        "QUEST_NOT_AVAILABLE",
        "ROOM_PERMISSION_DENIED",
        "HUB_UNAVAILABLE",
    ]

    for (const error of joinErrors) {
        target.setResult({ ok: false, error })
        const search = decode(await target.app.inject({
            method: "POST", url: "/search_room",
            payload: { viewer_id: 202, room_number: "123456" },
        }))
        const verify = decode(await target.app.inject({
            method: "POST", url: "/verify_access_token",
            payload: { viewer_id: 202, access_token: "access-token" },
        }))
        const select = decode(await target.app.inject({
            method: "POST", url: "/select_room",
            payload: { viewer_id: 202, room_number: "123456" },
        }))
        const prepare = decode(await target.app.inject({
            method: "POST", url: "/prepare",
            payload: { viewer_id: 202, room_number: "123456", category: 1, quest_id: 701 },
        }))

        assert.equal(search.data_headers.result_code, 4020, `search: ${error}`)
        assert.equal(verify.data_headers.result_code, 4020, `verify: ${error}`)
        assert.equal("room_exists" in search.data, false, `search missing guard: ${error}`)
        assert.equal("room_exists" in verify.data, false, `verify missing guard: ${error}`)
        assert.equal(select.data.raising_state, 7, `select: ${error}`)
        assert.equal(prepare.data_headers.result_code, 4507, `prepare: ${error}`)
        assert.equal("raising_state" in prepare.data, false, `prepare guard: ${error}`)
    }
})

test("actual missing rooms keep only the existing missing-room branches", async t => {
    const target = await routeServer({ result: { ok: false, error: "ROOM_NOT_FOUND" } })
    t.after(() => target.app.close())
    const search = decode(await target.app.inject({
        method: "POST", url: "/search_room",
        payload: { viewer_id: 202, room_number: "123456" },
    }))
    const verify = decode(await target.app.inject({
        method: "POST", url: "/verify_access_token",
        payload: { viewer_id: 202, access_token: "access-token" },
    }))
    const select = decode(await target.app.inject({
        method: "POST", url: "/select_room",
        payload: { viewer_id: 202, room_number: "123456" },
    }))
    const prepare = decode(await target.app.inject({
        method: "POST", url: "/prepare",
        payload: { viewer_id: 202, room_number: "123456", category: 1, quest_id: 701 },
    }))

    assert.equal(search.data.room_exists, false)
    assert.equal(verify.data.room_exists, false)
    assert.equal(select.data.raising_state, 9)
    assert.equal(prepare.data.raising_state, 9)
})

test("local QUEST_NOT_AVAILABLE uses endpoint-specific join mappings", async t => {
    const target = await routeServer({ questAvailable: false })
    t.after(() => target.app.close())
    const requests = [
        ["/search_room", { viewer_id: 202, room_number: "123456" }],
        ["/verify_access_token", { viewer_id: 202, access_token: "access-token" }],
        ["/select_room", { viewer_id: 202, room_number: "123456" }],
        ["/prepare", { viewer_id: 202, room_number: "123456", category: 1, quest_id: 701 }],
    ]
    const [search, verify, select, prepare] = await Promise.all(requests.map(
        ([url, payload]) => target.app.inject({ method: "POST", url, payload }).then(decode),
    ))
    assert.equal(search.data_headers.result_code, 4020)
    assert.equal(verify.data_headers.result_code, 4020)
    assert.equal(select.data.raising_state, 7)
    assert.equal(prepare.data_headers.result_code, 4507)
    assert.equal("raising_state" in prepare.data, false)
})

test("successful select and prepare pass the Hub TCP endpoint", async t => {
    const target = await routeServer()
    t.after(() => target.app.close())
    for (const [url, payload] of [
        ["/select_room", { viewer_id: 202, room_number: "123456" }],
        ["/prepare", { viewer_id: 202, room_number: "123456", category: 1, quest_id: 701 }],
    ]) {
        const response = decode(await target.app.inject({ method: "POST", url, payload }))
        assert.equal(response.data.ip_address, "hub.example")
        assert.equal(response.data.port, 9103)
        assert.equal(response.data.application_update_url, "")
    }
})

test("client runtime installs the remote coordinator lazily while local modes stay local", async () => {
    const remote = new RemoteMultiCoordinator({
        read: async () => ({ ok: false, error: "ROOM_NOT_FOUND" }),
        write: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
        getTcpEndpoint: () => ({ host: "hub.example", port: 8003 }),
        getNodeSessionId: () => "node-a",
        isAvailable: () => true,
    })
    const calls = []
    const service = createMultiRuntimeService({
        startTcp: async () => { calls.push("tcp-start") },
        stopTcp: async () => { calls.push("tcp-stop") },
        isTcpListening: () => true,
        startHub: async () => { calls.push("hub-start") },
        stopHub: async () => { calls.push("hub-stop") },
        isHubListening: () => true,
        createRemoteCoordinator: () => remote,
    })
    await service.start({
        mode: "client",
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
    })
    assert.equal(service.getHttpContext().coordinator, remote)
    assert.deepEqual(calls, [])
    assert.deepEqual(service.getStatus(), {
        mode: "client",
        state: "ready",
        coordinator: { kind: "remote", available: true },
        hub: { available: true, endpoint: "http://hub.example/" },
        tcp: { available: true, endpoint: "hub.example:8003" },
    })
    await service.stop()
    assert.deepEqual(calls, [])
})

test("multi start rechecks local quest availability before entry writes", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/multi/http/battle.ts"), "utf8")
    const availability = source.indexOf("context.questAvailability.check(category, quest_id)")
    const entryWrite = source.indexOf("runStartEntryTransaction({")
    assert.ok(availability >= 0)
    assert.ok(entryWrite > availability)
})

test("remote client does not send server time or CDN alignment fields", async () => {
    const bodies = []
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: TOKEN,
        fetch: async (url, init) => {
            bodies.push(JSON.parse(init.body))
            return String(url).endsWith("/nodes/register")
                ? jsonResponse(registration())
                : jsonResponse({ ok: false, code: "QUEST_NOT_AVAILABLE" })
        },
    })
    await client.read("/v1/multi/rooms/search", {
        participant: participant(), roomNumber: "123456", compatibility,
    })
    const serialized = JSON.stringify(bodies)
    assert.doesNotMatch(serialized, /serverTime|servertime|timeOffset|asset_update|update_url/i)
})
