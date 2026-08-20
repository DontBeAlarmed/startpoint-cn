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
    let failTcpStarts = options.failTcpStarts ?? (options.failTcp ? Infinity : 0)
    let stopTcpFailures = options.stopTcpFailures ?? 0
    const tcpConfigs = []
    const tcpTunings = []
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
        startTcp: async (config, _onFatalError, _hostServices, tuning) => {
            tcpStarts++
            tcpConfigs.push(config)
            tcpTunings.push(tuning)
            if (failTcpStarts > 0) {
                failTcpStarts--
                throw new Error("fallback tcp unavailable")
            }
            tcpListening = true
        },
        stopTcp: async () => {
            if (stopTcpFailures > 0) {
                stopTcpFailures--
                throw new Error("fallback tcp stop unavailable")
            }
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
        tcpTunings,
        get tcpStarts() { return tcpStarts },
        setNow(value) { now = value },
        setControlAvailable(value) {
            controlAvailable = value
            if (!value) remoteAvailable = false
        },
        async start() {
            const config = {
                mode: "client",
                hubUrl: new URL("http://hub.example/"),
                token: "token",
            }
            if (options.tcpConfig) config.tcp = options.tcpConfig
            await service.start(config, undefined, options.tuning)
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

test("Client lazy fallback forwards the same runtime tuning snapshot", async t => {
    const tuning = Object.freeze({
        transport: Object.freeze({
            handshakeTimeoutMs: 16000,
            maxFrameBytes: 524288,
            maxBufferBytes: 2097152,
            keepAliveInitialDelayMs: 11000,
            sendQueueMaxMessages: 768,
            sendQueueMaxBytes: 8388608,
            sendQueueMaxAgeMs: 17000,
        }),
        battle: Object.freeze({ loadingLeaseMs: 70000, heartbeatLeaseMs: 30000 }),
        roomCleanup: Object.freeze({
            incompleteExpiryMs: 120000,
            fullExpiryMs: 240000,
            intervalMs: 15000,
            reconnectGraceMs: 18000,
        }),
        npcRecruitment: Object.freeze({ joinDelayMs: 250, readyDelayMs: 75 }),
    })
    const fixture = createClientFixture({ controlAvailable: false, tuning })
    t.after(() => fixture.stop())
    await fixture.start()

    assert.deepEqual(fixture.tcpTunings, [])
    await fixture.service.getHttpContext().resolveCoordinatorOrigin({ participant: participant(251) })

    assert.equal(fixture.tcpTunings.length, 1)
    assert.equal(fixture.tcpTunings[0], tuning)
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

test("Client fallback stop failure is retryable before a clean restart", async t => {
    const fixture = createClientFixture({ controlAvailable: false, stopTcpFailures: 1 })
    t.after(async () => {
        try {
            await fixture.stop()
        } catch {
            // The test already exercises the first failed cleanup; final cleanup retries it.
            await fixture.stop()
        }
    })
    await fixture.start()
    const context = fixture.service.getHttpContext()
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(326) }), "local")
    assert.equal(fixture.tcpStarts, 1)

    await assert.rejects(fixture.stop(), /fallback tcp stop unavailable/)
    await fixture.stop()

    await fixture.start()
    const restartedContext = fixture.service.getHttpContext()
    assert.equal(await restartedContext.resolveCoordinatorOrigin({ participant: participant(327) }), "local")
    assert.equal(fixture.tcpStarts, 2)
})

test("shared Client fallback listens locally and advertises its public TCP endpoint", async t => {
    const fixture = createClientFixture({
        controlAvailable: false,
        tcpConfig: {
            host: "0.0.0.0",
            port: 8013,
            publicHost: "client-b.internal",
        },
    })
    t.after(() => fixture.stop())
    await fixture.start()

    const context = fixture.service.getHttpContext()
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(351) }), "local")
    assert.deepEqual(fixture.tcpConfigs[0], {
        host: "0.0.0.0",
        port: 8013,
        publicHost: "client-b.internal",
    })
    assert.deepEqual(fixture.service.getStatus().tcp, {
        available: true,
        endpoint: "client-b.internal:8013",
    })
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

test("a transient fallback TCP start failure retries once after cooldown", async t => {
    const fixture = createClientFixture({
        controlAvailable: false,
        failTcpStarts: 1,
    })
    t.after(() => fixture.stop())
    await fixture.start()
    const context = fixture.service.getHttpContext()

    assert.deepEqual(await Promise.all([
        context.resolveCoordinatorOrigin({ participant: participant(701) }),
        context.resolveCoordinatorOrigin({ participant: participant(702) }),
    ]), ["local", "local"])
    assert.equal(fixture.tcpStarts, 1)
    assert.equal(fixture.service.getStatus().clientFallbackState, "degraded")

    fixture.setNow(10_999)
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(703) }), "local")
    assert.equal(fixture.tcpStarts, 1)

    fixture.setNow(11_001)
    assert.equal(await context.resolveCoordinatorOrigin({ participant: participant(704) }), "local")
    assert.equal(fixture.tcpStarts, 2)
    assert.equal(fixture.service.getStatus().clientFallbackState, "local")
})
