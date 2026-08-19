const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { sessionManager } = require("../src/multi/state/SessionManager")
const { relayToBattleRoom } = require("../src/multi/tcp/relay")

class RelaySocket extends EventEmitter {
    constructor(onWrite) {
        super()
        this.destroyed = false
        this.writable = true
        this.frames = []
        this.onWrite = onWrite
    }

    write(frame) {
        this.frames.push(frame)
        this.onWrite?.()
        return true
    }

    destroy() {
        if (this.destroyed) return this
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
    }
}

let sequence = 0
const cleanup = []

function addBattleClient(roomNumber, connectionId, socket = new RelaySocket()) {
    const client = sessionManager.createClient(
        socket,
        900_000_000 + ++sequence,
        roomNumber,
        connectionId,
    )
    client.isBattle = true
    client.participant = {
        nodeSessionId: `relay-node-${sequence}`,
        viewerId: client.viewerId,
    }
    sessionManager.addBattleClient(connectionId, client)
    cleanup.push(client)
    return client
}

test.afterEach(() => {
    while (cleanup.length > 0) {
        const client = cleanup.pop()
        if (sessionManager.getBattleClient(client.connectionId) === client) {
            sessionManager.removeBattleClient(client.connectionId)
        }
    }
})

test("one logical relay snapshots recipients and serializes its payload once", () => {
    const roomNumber = `relay-snapshot-${sequence}`
    const source = addBattleClient(roomNumber, `source-${sequence}`)
    let second
    const firstSocket = new RelaySocket(() => {
        sessionManager.removeBattleClient(second.connectionId)
    })
    const first = addBattleClient(roomNumber, `first-${sequence}`, firstSocket)
    second = addBattleClient(roomNumber, `second-${sequence}`)
    let serializationCalls = 0
    const payload = [2, source.connectionId, [{
        toJSON() {
            serializationCalls++
            return 99
        },
    }]]

    relayToBattleRoom(source, payload)

    assert.equal(serializationCalls, 1)
    assert.equal(first.socket.frames.length, 1)
    assert.equal(second.socket.frames.length, 1)
    assert.deepEqual(JSON.parse(first.socket.frames[0].slice(0, -1)), [
        2,
        source.connectionId,
        [99],
    ])
})

test("a replacement battle socket remains authoritative after the old socket closes", () => {
    const roomNumber = `relay-replacement-${sequence}`
    const oldSource = addBattleClient(roomNumber, `source-${sequence}`)
    const target = addBattleClient(roomNumber, `target-${sequence}`)
    const replacement = addBattleClient(
        roomNumber,
        oldSource.connectionId,
        new RelaySocket(),
    )

    assert.equal(oldSource.socket.destroyed, true)
    assert.equal(sessionManager.getBattleClient(oldSource.connectionId), replacement)
    assert.deepEqual(sessionManager.snapshotBattleRelayRecipients(oldSource), [])

    sessionManager.removeClient(oldSource)
    assert.equal(sessionManager.getBattleClient(oldSource.connectionId), replacement)

    relayToBattleRoom(oldSource, [2, oldSource.connectionId, [1]])
    assert.equal(target.socket.frames.length, 0)
    relayToBattleRoom(replacement, [2, replacement.connectionId, [2]])
    assert.equal(target.socket.frames.length, 1)
})

test("a cross-room connection replacement cannot leak through the old room index", () => {
    const oldRoom = `relay-old-room-${sequence}`
    const newRoom = `relay-new-room-${sequence}`
    const oldTarget = addBattleClient(oldRoom, `old-target-${sequence}`)
    const oldConnection = addBattleClient(oldRoom, `shared-${sequence}`)
    const replacementSocket = new RelaySocket()
    const replacement = sessionManager.createClient(
        replacementSocket,
        900_000_000 + ++sequence,
        newRoom,
        oldConnection.connectionId,
    )
    replacement.isBattle = true
    replacement.participant = {
        nodeSessionId: `relay-node-${sequence}`,
        viewerId: replacement.viewerId,
    }

    assert.equal(sessionManager.addBattleClient(replacement.connectionId, replacement), false)
    replacementSocket.destroy()
    assert.equal(sessionManager.getBattleClient(oldConnection.connectionId), oldConnection)
    assert.equal(sessionManager.battleClients.has(newRoom), false)
    sessionManager.broadcastToBattleRoom(oldRoom, [1, [9]])
    assert.equal(oldTarget.socket.frames.length, 1)
    assert.equal(oldConnection.socket.frames.length, 1)

    sessionManager.closeRoomClients(oldRoom)
    assert.equal(sessionManager.getBattleClient(oldConnection.connectionId), undefined)
})
