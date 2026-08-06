"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")

const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

function participant(viewerId) {
    return { nodeSessionId: "client-node", viewerId }
}

function roomStatus(origin, input, roomNumber) {
    return {
        roomNumber,
        accessToken: `${origin}-${roomNumber}`,
        category: input.category ?? 1,
        questId: input.questId ?? 701,
        hostEntryTime: 1,
        roomSequence: 1,
        raisingState: 1,
        shareRoomOptions: 0,
        hostMainCharacterId: input.leaderCharacterId ?? 401,
        isNpcMode: false,
        hostOnline: true,
        host: input.participant,
        members: [input.participant],
        compatibility,
    }
}

function createCoordinator(origin) {
    let sequence = 0
    const calls = []
    const rooms = new Map()
    const invoke = name => async input => {
        calls.push({ name, input })
        if (name === "createRoom") {
            const roomNumber = `${origin === "remote" ? "1" : "2"}${String(++sequence).padStart(5, "0")}`
            const room = roomStatus(origin, input, roomNumber)
            rooms.set(roomNumber, room)
            return { ok: true, value: room }
        }
        if (name === "getRoomStatus") {
            return rooms.has(input.roomNumber)
                ? { ok: true, value: rooms.get(input.roomNumber) }
                : { ok: false, error: "ROOM_NOT_FOUND" }
        }
        if (name === "disbandRoom" || name === "abortBattle") {
            return { ok: true, value: undefined }
        }
        return { ok: false, error: "ROOM_NOT_FOUND" }
    }
    return {
        calls,
        rooms,
        coordinator: {
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
        },
    }
}

function createClientFixture(options = {}) {
    let now = options.now ?? 10_000
    let tcpListening = false
    let tcpStarts = 0
    const tcpConfigs = []
    const remote = createCoordinator("remote")
    const local = createCoordinator("local")
    let controlAvailable = options.controlAvailable ?? true
    let remoteAvailable = controlAvailable
    const activeOrigins = new Map()

    const remoteCoordinator = {
        ...remote.coordinator,
        getTcpEndpoint: () => remoteAvailable ? { host: "hub.example", port: 8003 } : null,
        getNodeSessionId: () => "remote-node",
        isAvailable: () => remoteAvailable,
        getControlStatus: async () => {
            options.onControlProbe?.()
            if (!controlAvailable) {
                remoteAvailable = false
                return { ok: false, error: "HUB_UNAVAILABLE" }
            }
            remoteAvailable = true
            return { ok: true, value: { tcpAvailable: true } }
        },
        getExistingSessionControlStatus: async () => null,
    }
    if (options.remoteWriteLost) {
        remoteCoordinator.createRoom = async () => ({ ok: false, error: "HUB_UNAVAILABLE" })
    }

    const service = createMultiRuntimeService({
        startTcp: async config => {
            tcpStarts++
            tcpConfigs.push(config)
            if (options.failTcp) throw new Error("fallback tcp unavailable")
            tcpListening = true
        },
        stopTcp: async () => {
            tcpListening = false
        },
        isTcpListening: () => tcpListening,
        startHub: async () => {},
        stopHub: async () => {},
        isHubListening: () => false,
        createRemoteCoordinator: () => remoteCoordinator,
        createLocalCoordinator: () => local.coordinator,
        resolveActiveQuestOrigin: async current => activeOrigins.get(current.viewerId) ?? null,
        resolveActiveQuestOriginSync: viewerId => activeOrigins.get(viewerId) ?? null,
        now: () => now,
    })

    return {
        service,
        remote,
        local,
        activeOrigins,
        tcpConfigs,
        get tcpStarts() { return tcpStarts },
        setNow(value) { now = value },
        setControlAvailable(value) {
            controlAvailable = value
            if (!value) remoteAvailable = false
        },
        async start() {
            await service.start({
                mode: "client",
                hubUrl: new URL("http://hub.example/"),
                token: "token",
            })
        },
        async stop() {
            await service.stop()
        },
    }
}

function createRoomInput(viewerId, requestId) {
    return {
        requestId,
        participant: participant(viewerId),
        partyId: 1,
        category: 1,
        questId: 701,
        leaderCharacterId: 401,
        compatibility,
    }
}

test("Client Hub ready routes a new room to remote", async t => {
    const fixture = createClientFixture()
    t.after(() => fixture.stop())
    await fixture.start()

    const result = await fixture.service.getHttpContext().coordinator.createRoom(
        createRoomInput(101, "remote-room"),
    )

    assert.equal(result.ok, true)
    assert.equal(fixture.remote.calls.filter(call => call.name === "createRoom").length, 1)
    assert.equal(fixture.local.calls.filter(call => call.name === "createRoom").length, 0)
    assert.equal(fixture.service.getStatus().clientFallbackState, "remote")
})

test("Hub disconnect keeps an existing remote active quest remote and routes a new room local", async t => {
    const fixture = createClientFixture({ controlAvailable: false })
    fixture.activeOrigins.set(201, "remote")
    t.after(() => fixture.stop())
    await fixture.start()

    const context = fixture.service.getHttpContext()
    assert.equal(await context.resolveCoordinatorOrigin({
        participant: participant(201),
        roomNumber: "100001",
    }), "remote")
    assert.deepEqual(context.snapshotProvider.getParticipant(201), {
        nodeSessionId: "remote-node",
        viewerId: 201,
    })
    assert.deepEqual(context.snapshotProvider.getParticipant(202), {
        nodeSessionId: "embedded",
        viewerId: 202,
    })
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(202) }), "local")
    assert.deepEqual(fixture.tcpConfigs[0], { host: "127.0.0.1", port: 8003 })
    assert.equal(fixture.service.getStatus().clientFallbackState, "local")
})

test("local fallback TCP failure is degraded without tearing down HTTP or SQLite access", async t => {
    const fixture = createClientFixture({ controlAvailable: false, failTcp: true })
    t.after(() => fixture.stop())
    await fixture.start()

    const context = fixture.service.getHttpContext()
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(301) }), "local")
    assert.equal(fixture.service.getStatus().state, "degraded")
    assert.equal(fixture.service.getStatus().clientFallbackState, "degraded")
    assert.equal(fixture.service.getHttpContext(), context)
    assert.equal(context.coordinator !== undefined, true)
})

test("Hub recovery routes only new rooms remote and does not migrate existing rooms", async t => {
    const fixture = createClientFixture({ controlAvailable: true })
    t.after(() => fixture.stop())
    await fixture.start()
    const context = fixture.service.getHttpContext()

    const remoteRoom = await context.coordinator.createRoom(createRoomInput(401, "remote-existing"))
    assert.equal(remoteRoom.ok, true)

    fixture.setControlAvailable(false)
    const localRoom = await context.coordinator.createRoom(createRoomInput(402, "local-existing"))
    assert.equal(localRoom.ok, true)
    assert.equal(fixture.service.getStatus().clientFallbackState, "local")

    fixture.setControlAvailable(true)
    fixture.setNow(12_000)
    const recoveredRoom = await context.coordinator.createRoom(createRoomInput(403, "remote-recovered"))
    assert.equal(recoveredRoom.ok, true)
    assert.equal(fixture.service.getStatus().clientFallbackState, "remote")
    assert.equal(await context.resolveCoordinatorOrigin({
        participant: participant(401), roomNumber: remoteRoom.value.roomNumber,
    }), "remote")
    assert.equal(await context.resolveCoordinatorOrigin({
        participant: participant(402), roomNumber: localRoom.value.roomNumber,
    }), "local")
})

test("a lost remote write response never retries the room on local", async t => {
    const fixture = createClientFixture({ remoteWriteLost: true })
    t.after(() => fixture.stop())
    await fixture.start()

    const result = await fixture.service.getHttpContext().coordinator.createRoom(
        createRoomInput(501, "lost-write"),
    )

    assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
    assert.equal(fixture.local.calls.filter(call => call.name === "createRoom").length, 0)
})

test("failed Hub probes are cooldown bounded", async t => {
    let probes = 0
    const fixture = createClientFixture({
        controlAvailable: false,
        onControlProbe: () => probes++,
    })
    t.after(() => fixture.stop())
    await fixture.start()
    const context = fixture.service.getHttpContext()

    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(601) }), "local")
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(602) }), "local")
    assert.equal(probes, 1)
    assert.equal(fixture.tcpStarts, 1)

    fixture.setNow(11_001)
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(603) }), "local")
    assert.equal(probes, 2)
})
