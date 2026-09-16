"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const net = require("net")
const test = require("node:test")

const { sessionManager, SessionClient } = require("../src/multi/state/SessionManager")
const { addRoomMember, createRoom, disbandRoom } = require("../src/multi/room/manager")

class FakeSocket extends net.Socket {
    constructor() {
        super()
        this.writes = []
    }
    write(message) {
        this.writes.push(message)
        return true
    }
}

function client(viewerId, roomNumber, connectionId) {
    const socket = new FakeSocket()
    const created = sessionManager.createClient(socket, viewerId, roomNumber, connectionId)
    created.participant = { nodeSessionId: "embedded", viewerId }
    created.yourself = { viewerId, connectionId, party: {}, state: [0] }
    sessionManager.addClientToRoom(created)
    addRoomMember(roomNumber, created.participant)
    return created
}

function lastMateList(socket) {
    const frames = socket.writes.map(frame => String(frame).replace(/\0$/, ""))
    const mateFrames = frames
        .map(frame => { try { return JSON.parse(frame) } catch { return null } })
        .filter(message => Array.isArray(message) && message[0] === 1 && message[1]?.[0] === 1)
    const last = mateFrames[mateFrames.length - 1]
    return last ? last[1][1] : undefined
}

test.afterEach(() => {
    for (const roomNumber of [...sessionManager.roomsWithClients?.() ?? []]) {
        for (const c of sessionManager.getClientsInRoom(roomNumber)) {
            sessionManager.removeClient(c)
        }
    }
})

test("projectMateListForClient appends the missing self mate without duplicating", () => {
    const room = createRoom(701, 1701, 1, 1, 2701, 1, 3701, false, { nodeSessionId: "embedded", viewerId: 701 })
    const host = client(701, room.room_number, "host-701")
    const guest = client(702, room.room_number, "guest-702")

    // 房主权威列表暂时缺少 guest（如清理与重连交错）
    const authoritative = [host.yourself]
    const projected = sessionManager.projectMateListForClient(guest, authoritative)
    assert.equal(projected.length, 2, "缺失的自身份 mate 必须被投影补齐")
    assert.equal(projected.some(mate => mate.connectionId === "guest-702"), true)
    assert.equal(authoritative.length, 1, "投影不得修改权威列表")

    // 已含自身份时不制造重复
    const withSelf = [host.yourself, guest.yourself]
    const projectedAgain = sessionManager.projectMateListForClient(guest, withSelf)
    assert.equal(
        projectedAgain.filter(mate => mate.connectionId === "guest-702").length,
        1,
        "自身份已存在时不得重复",
    )
    assert.equal(sessionManager.projectMateListForClient(guest, withSelf), withSelf, "无需投影时返回原列表")

    sessionManager.removeClient(host)
    sessionManager.removeClient(guest)
    disbandRoom(room.room_number)
})

test("broadcastMateListToRoom guarantees every receiver's own mate", () => {
    const room = createRoom(703, 1703, 1, 1, 2703, 1, 3703, false, { nodeSessionId: "embedded", viewerId: 703 })
    const host = client(703, room.room_number, "host-703")
    const guestA = client(704, room.room_number, "guest-704")
    const guestB = client(705, room.room_number, "guest-705")
    const npcMate = { viewerId: 900000001, connectionId: `${room.room_number}-npc-11`, party: {} }

    // 权威列表缺少 B（并发离开/重连交错），含一名 NPC
    host.mates = [host.yourself, guestA.yourself, npcMate]

    sessionManager.broadcastMateListToRoom(room.room_number, host.mates)

    const aList = lastMateList(guestA.socket)
    assert.deepEqual(
        aList.map(mate => mate.connectionId),
        ["host-703", "guest-704", `${room.room_number}-npc-11`],
        "A 收到权威列表原样",
    )
    const bList = lastMateList(guestB.socket)
    assert.equal(
        bList.some(mate => mate.connectionId === "guest-705"),
        true,
        "B 的自身份 mate 必须存在于其收到的列表",
    )
    assert.equal(
        bList.filter(mate => mate.connectionId === "guest-705").length,
        1,
        "不得制造重复",
    )
    assert.equal(bList.some(mate => mate.connectionId === `${room.room_number}-npc-11`), true)
    assert.equal(host.mates.length, 3, "权威列表不得被修改")

    for (const c of [host, guestA, guestB]) sessionManager.removeClient(c)
    disbandRoom(room.room_number)
})
