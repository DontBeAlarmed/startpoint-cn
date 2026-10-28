"use strict"

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const { sessionManager } = require("../src/multi/state/SessionManager")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
        this.writes = []
    }

    write(value) {
        this.writes.push(JSON.parse(String(value).replace(/\0$/, "")))
        return true
    }

    destroy() {
        this.destroyed = true
        this.writable = false
    }
}

test("broadcastAssetUpdateToAll 向全部在线会话发送 AssetUpdate(9) 帧并返回送达数", () => {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    const clients = sockets.map((socket, i) => {
        const client = sessionManager.createClient(socket, 910001 + i, "room-asset-update-broadcast", `conn-a-${i}`)
        client.participant = { nodeSessionId: "embedded", viewerId: 910001 + i }
        return client
    })
    for (const client of clients) sessionManager.addClientToRoom(client)
    try {
        const notified = sessionManager.broadcastAssetUpdateToAll()
        assert.equal(notified, 3)
        for (const socket of sockets) {
            assert.deepEqual(socket.writes, [[1, [9]]],
                "帧形必须与 MeetingServerMessage.AssetUpdate 一致：外层 [1, 内层消息]，内层 index 9 无参数")
        }
    } finally {
        for (const client of clients) sessionManager.removeClientBySocket(client.socket)
    }
})

test("broadcastAssetUpdateToAll 跳过已关闭 socket 且不计入送达数", () => {
    const alive = new FakeSocket()
    const dead = new FakeSocket()
    dead.writable = false
    const clients = [alive, dead].map((socket, i) => {
        const client = sessionManager.createClient(socket, 910101 + i, "room-asset-update-broadcast", `conn-b-${i}`)
        client.participant = { nodeSessionId: "embedded", viewerId: 910101 + i }
        return client
    })
    for (const client of clients) sessionManager.addClientToRoom(client)
    try {
        const notified = sessionManager.broadcastAssetUpdateToAll()
        assert.equal(notified, 1, "只有 writable 会话计入送达数")
        assert.deepEqual(alive.writes, [[1, [9]]])
        assert.equal(dead.writes.length, 0)
    } finally {
        for (const client of clients) sessionManager.removeClientBySocket(client.socket)
    }
})
