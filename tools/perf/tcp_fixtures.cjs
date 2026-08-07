"use strict"

const {
    createRoom,
    disbandRoom,
} = require("../../src/multi/room/manager")
const { embeddedAdmissionRegistry } = require("../../src/multi/admission/registry")

function snapshotFixture(viewerId) {
    return {
        viewerId,
        name: `Perf-${viewerId}`,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 101001,
        playerRoleKind: 1,
        isNewbie: false,
        currentPartyId: 1,
        party: {
            characters: [[1], [1], [1]],
            unison_characters: [[1], [1], [1]],
            equipments: [[1], [1], [1]],
            abilitySoulIds: [[1], [1], [1]],
        },
        npcParties: [],
    }
}

function createTcpFixtures({ clientsPerRoom, rooms, timeoutMs }) {
    const fixtures = []
    const baseViewerId = 700000000 + (Date.now() % 100000)
    for (let roomIndex = 0; roomIndex < rooms; roomIndex++) {
        const hostViewerId = baseViewerId + roomIndex * 10
        const room = createRoom(hostViewerId, hostViewerId + 1, 1, 1, 1, 1, 101001)
        const clients = []
        for (let clientIndex = 0; clientIndex < clientsPerRoom; clientIndex++) {
            const viewerId = hostViewerId + clientIndex
            const admission = embeddedAdmissionRegistry.issue({
                expiresAt: Date.now() + Math.max(timeoutMs * 4, 10_000),
                participant: { nodeSessionId: "embedded", viewerId },
                roomNumber: room.room_number,
                snapshot: snapshotFixture(viewerId),
            })
            if (!admission.ok) throw new Error(`failed to issue TCP admission: ${admission.error}`)
            clients.push({
                connectionId: `perf-${roomIndex}-${clientIndex}-${viewerId}`,
                viewerId,
            })
        }
        fixtures.push({ clients, roomNumber: room.room_number })
    }
    return fixtures
}

function disposeTcpFixtures(fixtures) {
    for (const fixture of fixtures) disbandRoom(fixture.roomNumber)
}

module.exports = { createTcpFixtures, disposeTcpFixtures }
