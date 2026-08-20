"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { RoutedMultiCoordinator } = require("../src/multi/coordinator/router")

const participant = Object.freeze({ nodeSessionId: "fault-node", viewerId: 901 })
const compatibility = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

function deferred() {
    let resolve
    const promise = new Promise(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

function room(origin, roomNumber = "123456") {
    return {
        roomNumber,
        accessToken: `${origin}-token`,
        category: 1,
        questId: 701,
        hostEntryTime: 1,
        roomSequence: 1,
        raisingState: 1,
        shareRoomOptions: 0,
        hostMainCharacterId: 401,
        isNpcMode: false,
        hostOnline: true,
        host: participant,
        members: [participant],
        compatibility,
    }
}

function coordinator(overrides = {}) {
    const missing = async () => ({ ok: false, error: "ROOM_NOT_FOUND" })
    return {
        createRoom: overrides.createRoom ?? missing,
        searchRoom: overrides.searchRoom ?? missing,
        prepareRoom: overrides.prepareRoom ?? missing,
        selectRoom: overrides.selectRoom ?? missing,
        disbandRoom: overrides.disbandRoom ?? missing,
        abortBattle: overrides.abortBattle ?? missing,
        startBattle: overrides.startBattle ?? missing,
        finalizeBattle: overrides.finalizeBattle ?? missing,
        getBattleStatus: overrides.getBattleStatus ?? missing,
        getRoomStatus: overrides.getRoomStatus ?? missing,
    }
}

test("an older room lookup callback cannot replace a newer origin generation", async () => {
    const oldLookup = deferred()
    const oldLookupStarted = deferred()
    let origin = "remote"
    const remote = coordinator({
        selectRoom: async () => {
            oldLookupStarted.resolve()
            return oldLookup.promise
        },
    })
    const local = coordinator({
        createRoom: async () => ({ ok: true, value: room("local") }),
    })
    const router = new RoutedMultiCoordinator({
        remote,
        local,
        remoteAdmissionIssuer: { issue: async () => ({ ok: false, error: "ROOM_NOT_FOUND" }) },
        localAdmissionIssuer: { issue: async () => ({ ok: false, error: "ROOM_NOT_FOUND" }) },
        newRoomOrigin: () => origin,
    })

    const staleSelection = router.selectRoom({
        participant,
        roomNumber: "123456",
        compatibility,
    })
    await oldLookupStarted.promise

    origin = "local"
    const created = await router.createRoom({
        requestId: "new-generation",
        participant,
        partyId: 1,
        category: 1,
        questId: 701,
        leaderCharacterId: 401,
        compatibility,
    })
    assert.equal(created.ok, true)

    oldLookup.resolve({ ok: true, value: room("remote") })
    assert.equal((await staleSelection).ok, true)

    assert.equal(await router.resolveOrigin({ participant, roomNumber: "123456" }), "local")
    assert.equal(await router.resolveOrigin({ participant, accessToken: "local-token" }), "local")
})

test("refreshing an old room cannot reclaim a participant owned by a newer room", async () => {
    const remoteRoomNumber = "111111"
    const localRoomNumber = "222222"
    let origin = "remote"
    const remote = coordinator({
        selectRoom: async () => ({ ok: true, value: room("remote", remoteRoomNumber) }),
        searchRoom: async () => ({ ok: true, value: room("remote", remoteRoomNumber) }),
    })
    const local = coordinator({
        createRoom: async () => ({ ok: true, value: room("local", localRoomNumber) }),
    })
    const router = new RoutedMultiCoordinator({
        remote,
        local,
        remoteAdmissionIssuer: { issue: async () => ({ ok: false, error: "ROOM_NOT_FOUND" }) },
        localAdmissionIssuer: { issue: async () => ({ ok: false, error: "ROOM_NOT_FOUND" }) },
        newRoomOrigin: () => origin,
    })

    assert.equal((await router.selectRoom({
        participant,
        roomNumber: remoteRoomNumber,
        compatibility,
    })).ok, true)

    origin = "local"
    assert.equal((await router.createRoom({
        requestId: "new-local-room",
        participant,
        partyId: 1,
        category: 1,
        questId: 701,
        leaderCharacterId: 401,
        compatibility,
    })).ok, true)
    assert.equal(await router.resolveOrigin({ participant }), "local")

    assert.equal((await router.searchRoom({
        participant,
        roomNumber: remoteRoomNumber,
        compatibility,
    })).ok, true)

    assert.equal(await router.resolveOrigin({ participant }), "local")
    assert.equal(await router.resolveOrigin({
        participant,
        roomNumber: remoteRoomNumber,
    }), "remote")
})
