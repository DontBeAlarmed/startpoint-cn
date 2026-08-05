"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")

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

test("invalid remote sessions remove their unconnected rooms and admissions only", async t => {
    let now = 1_000
    const enabled = new Map([
        ["credential-a", true],
        ["credential-b", true],
    ])
    const generated = [
        "remote-node-a", "a".repeat(43),
        "remote-node-b", "b".repeat(43),
    ]
    let generatedIndex = 0
    const admissions = new AdmissionRegistry({ now: () => now })
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const invalidations = []
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: 100,
        generateId: () => generated[generatedIndex++],
        isCredentialEnabled: credentialId => enabled.get(credentialId) === true,
        onInvalidated(nodeSessionId) {
            invalidations.push(nodeSessionId)
            admissions.removeByNodeSession(nodeSessionId)
            coordinator.cleanupNodeSession(nodeSessionId)
        },
    })
    const firstSession = sessions.register("credential-a", MULTI_PROTOCOL_VERSION)
    const secondSession = sessions.register("credential-b", MULTI_PROTOCOL_VERSION)
    const firstParticipant = { nodeSessionId: firstSession.nodeSessionId, viewerId: 501 }
    const secondParticipant = { nodeSessionId: secondSession.nodeSessionId, viewerId: 502 }
    const create = participant => coordinator.createRoom({
        requestId: `create-${participant.viewerId}`,
        participant,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    const firstRoom = await create(firstParticipant)
    const secondRoom = await create(secondParticipant)
    assert.equal(firstRoom.ok, true)
    assert.equal(secondRoom.ok, true)
    t.after(async () => {
        await coordinator.disbandRoom({
            participant: firstParticipant,
            roomNumber: firstRoom.value.roomNumber,
        })
        await coordinator.disbandRoom({
            participant: secondParticipant,
            roomNumber: secondRoom.value.roomNumber,
        })
    })
    for (const [room, participant] of [
        [firstRoom.value, firstParticipant],
        [secondRoom.value, secondParticipant],
    ]) {
        admissions.issue({
            roomNumber: room.roomNumber,
            participant,
            snapshot: snapshot(participant.viewerId),
            expiresAt: 5_000,
        })
    }

    enabled.set("credential-a", false)
    assert.equal(sessions.isValid(firstSession.nodeSessionId), false)
    assert.equal(sessions.isValid(firstSession.nodeSessionId), false)
    assert.deepEqual(invalidations, [firstSession.nodeSessionId])
    assert.equal(admissions.consume(firstRoom.value.roomNumber, 501), null)
    assert.deepEqual(await coordinator.getRoomStatus({
        participant: secondParticipant,
        roomNumber: firstRoom.value.roomNumber,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
    assert.equal((await coordinator.getRoomStatus({
        participant: secondParticipant,
        roomNumber: secondRoom.value.roomNumber,
    })).ok, true)
    assert.equal(admissions.consume(secondRoom.value.roomNumber, 502)?.participant.viewerId, 502)

    admissions.issue({
        roomNumber: secondRoom.value.roomNumber,
        participant: secondParticipant,
        snapshot: snapshot(502),
        expiresAt: 5_000,
    })
    now = 1_100
    assert.equal(sessions.sweep(), 1)
    assert.equal(sessions.sweep(), 0)
    assert.deepEqual(invalidations, [
        firstSession.nodeSessionId,
        secondSession.nodeSessionId,
    ])
    assert.equal(admissions.consume(secondRoom.value.roomNumber, 502), null)
    assert.deepEqual(await coordinator.getRoomStatus({
        participant: firstParticipant,
        roomNumber: secondRoom.value.roomNumber,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})
