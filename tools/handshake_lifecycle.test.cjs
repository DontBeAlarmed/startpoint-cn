const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

function deferred() {
    let resolve
    const promise = new Promise(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const playerContext = deferred()
stubModule("../src/multi/player-context", {
    resolveMultiPlayerContext: () => playerContext.promise,
})
stubModule("../src/data/domains/party", {
    getPlayerPartyGroupListSync: () => ({}),
})
stubModule("../src/data/domains/character", {
    getPlayerCharacterManaNodesSync: () => [],
    getPlayerCharacterSync: () => null,
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => null,
})

const { sessionManager } = require("../src/multi/state/SessionManager")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")
const { handleHandshake } = require("../src/multi/tcp/handshake")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.writable = true
    }
    write() { return true }
    end() { this.writable = false }
}

test("room handshake checks the lifecycle guard after async player resolution", async t => {
    const socket = new FakeSocket()
    const room = createRoom(93, 193, 1, 1, 293, 0, 393)
    t.after(() => disbandRoom(room.room_number))
    let accepting = true
    const handshake = handleHandshake(
        socket,
        {
            socklet: "cooperation_room",
            viewerId: 93,
            room_number: room.room_number,
            questCategory: room.category,
            questId: room.quest_id,
        },
        { generation: 7, isAccepting: () => accepting },
    )

    accepting = false
    playerContext.resolve({
        playerId: 193,
        player: { id: 193, name: "late-player", rankPoint: 0 },
    })
    await handshake

    assert.equal(sessionManager.getClient(93, room.room_number), undefined)
})

test("battle handshake refuses registration when its lifecycle generation is inactive", async () => {
    const socket = new FakeSocket()
    await handleHandshake(
        socket,
        { socklet: "cooperation_battle", room_number: "guard-battle", connection_id: "guard-cid" },
        { generation: 8, isAccepting: () => false },
    )

    assert.equal(sessionManager.getBattleClient("guard-cid"), undefined)
})
