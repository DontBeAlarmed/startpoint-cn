"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/utils", {
    getServerTime: () => 1_725_000_000,
})

let embeddedModule = {}
let contextModule = {}
try {
    embeddedModule = require("../src/multi/coordinator/embedded")
} catch {
    // RED: the embedded coordinator does not exist yet.
}
try {
    contextModule = require("../src/multi/http/context")
} catch {
    // RED: the HTTP context factory does not exist yet.
}

const {
    EMBEDDED_COMPATIBILITY,
    EMBEDDED_NODE_SESSION_ID,
    EmbeddedMultiCoordinator,
} = embeddedModule
const { createEmbeddedMultiHttpContext } = contextModule

const compatibility = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "1.8.1",
    RES_VER: "1",
    cdnTargetVersion: "embedded-cn",
    contentDigest: `sha256:${"1".repeat(64)}`,
    modeDigest: `sha256:${"2".repeat(64)}`,
})

function participant(viewerId) {
    return { nodeSessionId: EMBEDDED_NODE_SESSION_ID, viewerId }
}

function createInput(overrides = {}) {
    return {
        requestId: "create-room-1",
        participant: participant(101),
        localPlayerId: 201,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 401,
        compatibility,
        ...overrides,
    }
}

function compatibilityProfile(overrides = {}) {
    return { ...compatibility, ...overrides }
}

async function createFixture(t, overrides = {}) {
    const coordinator = new EmbeddedMultiCoordinator()
    const created = await coordinator.createRoom(createInput(overrides))
    assert.equal(created.ok, true)
    t.after(async () => {
        await coordinator.disbandRoom({
            participant: participant(101),
            roomNumber: created.value.roomNumber,
        })
    })
    return { coordinator, status: created.value }
}

test("exports the embedded coordinator and HTTP context factory", () => {
    assert.equal(typeof EmbeddedMultiCoordinator, "function")
    assert.equal(typeof EMBEDDED_NODE_SESSION_ID, "string")
    assert.notEqual(EMBEDDED_NODE_SESSION_ID.length, 0)
    assert.equal(typeof createEmbeddedMultiHttpContext, "function")
})

test("createRoom projects the local room into a node-scoped read-only status", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const { status } = await createFixture(t)

    assert.match(status.roomNumber, /^\d{6}$/)
    assert.match(status.accessToken, /^[A-Za-z0-9_-]{32,}$/)
    assert.equal(status.category, 1)
    assert.equal(status.questId, 501)
    assert.deepEqual(status.host, participant(101))
    assert.deepEqual(status.members, [participant(101)])
    assert.deepEqual(status.compatibility, compatibility)
    assert.equal(status.hostEntryTime, 1_725_000_000)
    assert.equal(Number.isSafeInteger(status.roomSequence), true)
    assert.equal(status.raisingState, 2)
    assert.equal(status.shareRoomOptions, 0)
    assert.equal(status.hostMainCharacterId, 401)
    assert.equal(status.isNpcMode, false)
    assert.equal(status.hostOnline, false)
})

test("searchRoom rejects a room with different participant compatibility", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const { coordinator, status } = await createFixture(t)
    const found = await coordinator.searchRoom({
        participant: participant(202),
        roomNumber: status.roomNumber,
        compatibility: {
            ...compatibility,
            APP_VER: "different",
            contentDigest: `sha256:${"3".repeat(64)}`,
            modeDigest: `sha256:${"4".repeat(64)}`,
        },
    })

    assert.deepEqual(found, { ok: false, error: "INCOMPATIBLE_ROOM" })
})

test("selectRoom and prepareRoom accept either non-empty locator value", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const { coordinator, status } = await createFixture(t)
    for (const operation of ["selectRoom", "prepareRoom"]) {
        const byNumber = await coordinator[operation]({
            participant: participant(202),
            roomNumber: status.roomNumber,
            compatibility,
        })
        const byToken = await coordinator[operation]({
            participant: participant(202),
            accessToken: status.accessToken,
            compatibility,
        })
        assert.equal(byNumber.ok, true, `${operation} by room number`)
        assert.equal(byToken.ok, true, `${operation} by access token`)
        assert.equal(byToken.value.roomNumber, status.roomNumber)
    }
})

test("room compatibility metadata is shared across embedded coordinator instances", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const creator = new EmbeddedMultiCoordinator()
    const reader = new EmbeddedMultiCoordinator()
    const customCompatibility = compatibilityProfile({
        APP_VER: "creator-app",
        RES_VER: "creator-resource",
        cdnTargetVersion: "creator-cdn",
        contentDigest: `sha256:${"5".repeat(64)}`,
        modeDigest: `sha256:${"6".repeat(64)}`,
    })
    const created = await creator.createRoom(createInput({ compatibility: customCompatibility }))
    assert.equal(created.ok, true)
    t.after(async () => {
        await creator.disbandRoom({
            participant: participant(101),
            roomNumber: created.value.roomNumber,
        })
    })

    for (const [operation, locator] of [
        ["searchRoom", { roomNumber: created.value.roomNumber }],
        ["selectRoom", { accessToken: created.value.accessToken }],
    ]) {
        const found = await reader[operation]({
            participant: participant(202),
            compatibility: customCompatibility,
            ...locator,
        })
        assert.equal(found.ok, true, operation)
        assert.deepEqual(found.value.compatibility, customCompatibility, operation)
    }
})

test("real missing rooms return ROOM_NOT_FOUND for every room lookup", async () => {
    if (!EmbeddedMultiCoordinator) return test.skip("embedded coordinator missing")

    const coordinator = new EmbeddedMultiCoordinator()
    for (const operation of ["searchRoom", "selectRoom", "prepareRoom"]) {
        const result = await coordinator[operation]({
            participant: participant(202),
            roomNumber: "000000",
            compatibility,
        })
        assert.deepEqual(result, { ok: false, error: "ROOM_NOT_FOUND" })
    }
    assert.deepEqual(
        await coordinator.getRoomStatus({
            participant: participant(202),
            roomNumber: "000000",
        }),
        { ok: false, error: "ROOM_NOT_FOUND" },
    )
})

test("disbandRoom rejects a non-host and lets the host broadcast then remove the room", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const { coordinator, status } = await createFixture(t)
    const { getRoom } = require("../src/multi/room/manager")
    const { sessionManager } = require("../src/multi/state/SessionManager")

    const guestResult = await coordinator.disbandRoom({
        participant: participant(202),
        roomNumber: status.roomNumber,
    })
    assert.deepEqual(guestResult, { ok: false, error: "ROOM_PERMISSION_DENIED" })
    assert.notEqual(getRoom(status.roomNumber), undefined)

    const broadcasts = []
    const originalBroadcast = sessionManager.broadcastToRoom
    sessionManager.broadcastToRoom = (roomNumber, message) => broadcasts.push({ roomNumber, message })
    let hostResult
    try {
        hostResult = await coordinator.disbandRoom({
            participant: participant(101),
            roomNumber: status.roomNumber,
        })
    } finally {
        sessionManager.broadcastToRoom = originalBroadcast
    }

    assert.deepEqual(hostResult, { ok: true, value: undefined })
    assert.deepEqual(broadcasts, [{
        roomNumber: status.roomNumber,
        message: [1, [6, "multibattle_room_dismissed"]],
    }])
    assert.equal(getRoom(status.roomNumber), undefined)
})

test("createRoom validates request identity, local ids and protocol version", async () => {
    if (!EmbeddedMultiCoordinator) return test.skip("embedded coordinator missing")

    const coordinator = new EmbeddedMultiCoordinator()
    const invalidInputs = [
        createInput({ requestId: " " }),
        createInput({ participant: participant(0) }),
        createInput({ partyId: 0 }),
        createInput({ category: -1 }),
        createInput({ questId: 1.5 }),
        createInput({ leaderCharacterId: Number.MAX_SAFE_INTEGER + 1 }),
        createInput({ localPlayerId: 0 }),
        createInput({ compatibility: { ...compatibility, multiProtocolVersion: 0 } }),
        createInput({ compatibility: { ...compatibility, multiProtocolVersion: 1.5 } }),
    ]

    for (const input of invalidInputs) {
        await assert.rejects(
            () => coordinator.createRoom(input),
            { name: "TypeError" },
        )
    }
})

test("createRoom rejects invalid runtime compatibility before creating a room", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const { disbandRoom: disbandLocalRoom, getRooms } = require("../src/multi/room/manager")
    const existingRoomNumbers = new Set(getRooms(1).map(room => room.room_number))
    t.after(() => {
        for (const room of getRooms(1)) {
            if (!existingRoomNumbers.has(room.room_number)) disbandLocalRoom(room.room_number)
        }
    })

    const coordinator = new EmbeddedMultiCoordinator()
    const fields = [
        "APP_VER",
        "RES_VER",
        "cdnTargetVersion",
        "contentDigest",
        "modeDigest",
    ]
    for (const field of fields) {
        for (const value of [" ", 123, null]) {
            const beforeCount = getRooms(1).length
            await assert.rejects(
                () => coordinator.createRoom(createInput({
                    compatibility: { ...compatibility, [field]: value },
                })),
                { name: "TypeError" },
                `${field}: ${String(value)}`,
            )
            assert.equal(getRooms(1).length, beforeCount, field)
        }
    }
})

test("zero valid room locators return ROOM_NOT_FOUND", async () => {
    if (!EmbeddedMultiCoordinator) return test.skip("embedded coordinator missing")

    const coordinator = new EmbeddedMultiCoordinator()
    for (const locator of [
        { roomNumber: undefined },
        { roomNumber: "" },
        { roomNumber: "   " },
        { accessToken: undefined },
        { accessToken: "" },
        { accessToken: "   " },
    ]) {
        for (const operation of ["searchRoom", "selectRoom", "prepareRoom"]) {
            assert.deepEqual(
                await coordinator[operation]({
                    participant: participant(202),
                    compatibility,
                    ...locator,
                }),
                { ok: false, error: "ROOM_NOT_FOUND" },
            )
        }
    }

    for (const operation of ["getRoomStatus", "disbandRoom", "startBattle"]) {
        assert.deepEqual(
            await coordinator[operation]({
                participant: participant(202),
                roomNumber: "",
            }),
            { ok: false, error: "ROOM_NOT_FOUND" },
        )
    }
})

test("two non-empty room locators are rejected as an internal contract conflict", async () => {
    if (!EmbeddedMultiCoordinator) return test.skip("embedded coordinator missing")

    const coordinator = new EmbeddedMultiCoordinator()
    await assert.rejects(
        () => coordinator.selectRoom({
            participant: participant(202),
            compatibility,
            roomNumber: "123456",
            accessToken: "token",
        }),
        { name: "TypeError" },
    )
})

test("room compatibility metadata follows the room object across external replacement", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const crypto = require("node:crypto")
    const {
        createRoom: createLocalRoom,
        disbandRoom: disbandLocalRoom,
    } = require("../src/multi/room/manager")
    const originalRandomInt = crypto.randomInt
    crypto.randomInt = () => 654321
    t.after(() => { crypto.randomInt = originalRandomInt })

    const coordinator = new EmbeddedMultiCoordinator()
    const oldProfile = compatibilityProfile({ contentDigest: `sha256:${"a".repeat(64)}` })
    const created = await coordinator.createRoom(createInput({ compatibility: oldProfile }))
    assert.equal(created.ok, true)
    assert.equal(created.value.roomNumber, "654321")

    assert.equal(disbandLocalRoom(created.value.roomNumber), true)
    assert.deepEqual(
        await coordinator.getRoomStatus({
            participant: participant(101),
            roomNumber: created.value.roomNumber,
        }),
        { ok: false, error: "ROOM_NOT_FOUND" },
    )

    const replacement = createLocalRoom(303, 403, 1, 1, 502, 0, 402)
    t.after(() => disbandLocalRoom(replacement.room_number))
    assert.equal(replacement.room_number, created.value.roomNumber)

    const replacementStatus = await coordinator.getRoomStatus({
        participant: participant(303),
        roomNumber: replacement.room_number,
    })
    assert.equal(replacementStatus.ok, true)
    assert.deepEqual(replacementStatus.value.compatibility, EMBEDDED_COMPATIBILITY)
})

test("room statuses are immutable snapshots isolated from later queries", async t => {
    if (!EmbeddedMultiCoordinator) return t.skip("embedded coordinator missing")

    const originalDigest = `sha256:${"7".repeat(64)}`
    const mutableProfile = compatibilityProfile({ contentDigest: originalDigest })
    const { coordinator, status } = await createFixture(t, { compatibility: mutableProfile })

    assert.equal(Object.isFrozen(status), true)
    assert.equal(Object.isFrozen(status.host), true)
    assert.equal(Object.isFrozen(status.members), true)
    assert.equal(Object.isFrozen(status.members[0]), true)
    assert.equal(Object.isFrozen(status.compatibility), true)
    assert.throws(() => { status.members[0].viewerId = 999 })
    assert.throws(() => { status.compatibility.contentDigest = "mutated-status" })
    mutableProfile.contentDigest = "mutated-input"

    const queried = await coordinator.getRoomStatus({
        participant: participant(101),
        roomNumber: status.roomNumber,
    })
    assert.equal(queried.ok, true)
    assert.equal(queried.value.members[0].viewerId, 101)
    assert.equal(queried.value.compatibility.contentDigest, originalDigest)
})

test("embedded HTTP contexts copy compatibility and isolate coordinators", async () => {
    if (!createEmbeddedMultiHttpContext) return test.skip("HTTP context missing")

    const firstDigest = `sha256:${"8".repeat(64)}`
    const secondDigest = `sha256:${"9".repeat(64)}`
    const firstInput = compatibilityProfile({ contentDigest: firstDigest })
    const secondInput = compatibilityProfile({ contentDigest: secondDigest })
    const first = createEmbeddedMultiHttpContext({ compatibility: firstInput })
    const second = createEmbeddedMultiHttpContext({ compatibility: secondInput })

    firstInput.contentDigest = "mutated-first"
    secondInput.contentDigest = "mutated-second"
    assert.notEqual(first.coordinator, second.coordinator)
    assert.equal(first.snapshotProvider.getCompatibility({}).value.contentDigest, firstDigest)
    assert.equal(second.snapshotProvider.getCompatibility({}).value.contentDigest, secondDigest)
    assert.notEqual(
        first.snapshotProvider.getCompatibility({}).value,
        second.snapshotProvider.getCompatibility({}).value,
    )
})

test("embedded HTTP and default TCP admission wiring share one registry", () => {
    const { embeddedAdmissionRegistry } = require("../src/multi/admission/registry")
    const { DEFAULT_SESSION_ADMISSION_PROVIDER } = require("../src/multi/tcp/server")
    const context = createEmbeddedMultiHttpContext({ compatibility })

    assert.equal(context.admissionProvider, embeddedAdmissionRegistry)
    assert.equal(context.admissionIssuer, embeddedAdmissionRegistry)
    assert.equal(DEFAULT_SESSION_ADMISSION_PROVIDER, embeddedAdmissionRegistry)
})

test("host coordinator scopes viewer conflicts and room ownership by node session", async t => {
    const { disbandRoom: disbandLocalRoom } = require("../src/multi/room/manager")
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const host = { nodeSessionId: "node-a", viewerId: 707 }
    const created = await coordinator.createRoom({
        requestId: "host-room",
        participant: host,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    t.after(() => disbandLocalRoom(created.value.roomNumber))

    const conflicting = await coordinator.searchRoom({
        participant: { nodeSessionId: "node-b", viewerId: host.viewerId },
        roomNumber: created.value.roomNumber,
        compatibility,
    })
    assert.deepEqual(conflicting, { ok: false, error: "VIEWER_ID_CONFLICT" })

    const compatible = await coordinator.searchRoom({
        participant: { nodeSessionId: "node-b", viewerId: 708 },
        roomNumber: created.value.roomNumber,
        compatibility,
    })
    assert.equal(compatible.ok, true)
    assert.deepEqual(compatible.value.host, host)

    const forgedDisband = await coordinator.disbandRoom({
        participant: { nodeSessionId: "node-b", viewerId: host.viewerId },
        roomNumber: created.value.roomNumber,
    })
    assert.deepEqual(forgedDisband, { ok: false, error: "ROOM_PERMISSION_DENIED" })
    assert.deepEqual(await coordinator.disbandRoom({
        participant: host,
        roomNumber: created.value.roomNumber,
    }), { ok: true, value: undefined })
})

test("embedded HTTP context carries all four injected collaborators", async t => {
    if (!createEmbeddedMultiHttpContext) return t.skip("HTTP context missing")

    const resolved = { playerId: 201, player: { leaderCharacterId: 401 } }
    const context = createEmbeddedMultiHttpContext({
        compatibility,
        resolvePlayerContext: async viewerId => viewerId === 101 ? resolved : null,
    })

    assert.equal(context.coordinator instanceof EmbeddedMultiCoordinator, true)
    assert.equal(await context.resolvePlayerContext(101), resolved)
    assert.deepEqual(context.snapshotProvider.getParticipant(101), participant(101))
    assert.deepEqual(context.snapshotProvider.getCompatibility({}), {
        ok: true,
        value: compatibility,
    })
    assert.equal(typeof context.settlementVerifier.getBattleStatus, "function")
})
