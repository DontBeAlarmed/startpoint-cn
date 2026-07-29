const assert = require("node:assert/strict")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const test = require("node:test")

require("ts-node/register/transpile-only")

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
    generateDataHeaders: ({ viewer_id } = {}) => ({ viewer_id: viewer_id ?? 0 }),
})

const players = new Map([
    [101, { playerId: 201, player: { id: 201, name: "Host", rankPoint: 0, leaderCharacterId: 401 } }],
    [202, { playerId: 302, player: { id: 302, name: "Guest", rankPoint: 0, leaderCharacterId: 402 } }],
    [303, { playerId: 403, player: { id: 403, name: "Stranger", rankPoint: 0, leaderCharacterId: 403 } }],
])
stubModule("../src/multi/player-context", {
    resolveMultiPlayerContext: async viewerId => players.get(viewerId) ?? null,
    getPlayerRankLevel: () => 1,
})
stubModule("../src/data/domains/session", {
    getSession: async viewerId => players.has(Number(viewerId)) ? { accountId: Number(viewerId) } : null,
})
stubModule("../src/lib/assets", {
    getQuestFromCategorySync: () => ({}),
})
stubModule("../src/multi/npc/builder", {
    buildNpcMates: () => ({ mate1: null, mate2: null }),
})

const {
    addRoomMember,
    createRoom,
    disbandRoom,
    getRoomByToken,
    isRoomMember,
    removeRoomMember,
} = require("../src/multi/room/manager")
const { getRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { registerSocialRoutes } = require("../src/multi/http/social")

async function createRouteServer() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    registerLobbyRoutes(fastify)
    registerRoomRoutes(fastify)
    registerSocialRoutes(fastify)
    await fastify.ready()
    return fastify
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

test("each room receives an unguessable token that resolves only to that room", t => {
    const first = createRoom(101, 201, 1, 1, 301, 0, 401)
    const second = createRoom(102, 202, 1, 1, 302, 0, 402)
    t.after(() => {
        disbandRoom(first.room_number)
        disbandRoom(second.room_number)
    })

    assert.notEqual(first.access_token, second.access_token)
    assert.match(first.access_token, /^[A-Za-z0-9_-]{32,}$/)
    assert.equal(getRoomByToken(first.access_token)?.room_number, first.room_number)
    assert.equal(getRoomByToken(second.access_token)?.room_number, second.room_number)
    assert.equal(getRoomByToken("multi_battle_quest_access_token"), undefined)
})

test("room membership survives disconnect bookkeeping until an explicit leave", t => {
    const room = createRoom(111, 211, 1, 1, 311, 0, 411)
    t.after(() => disbandRoom(room.room_number))

    assert.equal(isRoomMember(room, 111), true)
    assert.equal(isRoomMember(room, 222), false)
    assert.equal(addRoomMember(room.room_number, 222), true)
    assert.equal(isRoomMember(room, 222), true)
    assert.equal(removeRoomMember(room.room_number, 222), true)
    assert.equal(isRoomMember(room, 222), false)
})

test("random matching stays empty and access-token verification follows the CN parser contract", async t => {
    const fastify = await createRouteServer()
    const room = createRoom(101, 201, 1, 1, 501, 0, 401)
    const socket = { writable: true, write: () => true }
    const hostClient = sessionManager.createClient(socket, 101, room.room_number, "host-cid", 201)
    sessionManager.addClientToRoom(hostClient)
    t.after(async () => {
        sessionManager.removeClient(hostClient)
        disbandRoom(room.room_number)
        await fastify.close()
    })

    const roomsResponse = await fastify.inject({
        method: "POST",
        url: "/get_rooms",
        payload: { viewer_id: 101, category_id: 1, party_id: 1, api_count: 1 },
    })
    assert.deepEqual(decode(roomsResponse).data.rooms, [])

    const invalid = await fastify.inject({
        method: "POST",
        url: "/verify_access_token",
        payload: { viewer_id: 202, access_token: "invalid", api_count: 2 },
    })
    assert.deepEqual(decode(invalid).data, { room_exists: false })

    const valid = await fastify.inject({
        method: "POST",
        url: "/verify_access_token",
        payload: { viewer_id: 202, access_token: room.access_token, api_count: 3 },
    })
    assert.deepEqual(decode(valid).data, {
        room_exists: true,
        category_id: 1,
        establisher: 101,
        establisher_character: 401,
        establisher_character_evolution_img_level: 0,
        establisher_follow: 0,
        establisher_name: "Host",
        establisher_rank: 1,
        host_entry_time: 1_725_000_000,
        quest_id: 501,
        room_number: room.room_number,
    })

    const publish = await fastify.inject({
        method: "POST",
        url: "/publish_room",
        payload: { viewer_id: 101, room_number: room.room_number, token: "unused", api_count: 4 },
    })
    assert.deepEqual(decode(publish).data, { success: false })
})

test("room mutations require an authenticated host while restore accepts recorded members only", async t => {
    const fastify = await createRouteServer()
    const room = createRoom(101, 201, 1, 1, 601, 0, 401)
    addRoomMember(room.room_number, 202)
    t.after(async () => {
        disbandRoom(room.room_number)
        await fastify.close()
    })

    const guestSummon = await fastify.inject({
        method: "POST",
        url: "/summon",
        payload: { viewer_id: 202, room_number: room.room_number, category_id: 1, quest_id: 601, api_count: 1 },
    })
    assert.equal(guestSummon.statusCode, 403)

    const firstPrepare = await fastify.inject({
        method: "POST",
        url: "/prepare",
        payload: { viewer_id: 303, room_number: room.room_number, category: 1, quest_id: 601, api_count: 2 },
    })
    assert.equal(firstPrepare.statusCode, 200, "prepare is the authenticated pre-membership entry point")

    const mismatchedPrepare = await fastify.inject({
        method: "POST",
        url: "/prepare",
        payload: { viewer_id: 303, room_number: room.room_number, category: 1, quest_id: 999, api_count: 3 },
    })
    assert.equal(mismatchedPrepare.statusCode, 400)

    const guestShare = await fastify.inject({
        method: "POST",
        url: "/share_room",
        payload: { viewer_id: 202, room_number: room.room_number, api_count: 4 },
    })
    assert.equal(guestShare.statusCode, 403)

    const strangerRestore = await fastify.inject({
        method: "POST",
        url: "/restore_room",
        payload: { viewer_id: 303, room_number: room.room_number, room_sequence: room.room_sequence, api_count: 5 },
    })
    assert.equal(strangerRestore.statusCode, 200)
    assert.equal(decode(strangerRestore).data.raising_state, 13)

    const memberRestore = await fastify.inject({
        method: "POST",
        url: "/restore_room",
        payload: { viewer_id: 202, room_number: room.room_number, room_sequence: room.room_sequence, api_count: 6 },
    })
    assert.notEqual(decode(memberRestore).data.raising_state, 13)

    const guestDisband = await fastify.inject({
        method: "POST",
        url: "/disband_room",
        payload: { viewer_id: 202, room_number: room.room_number, api_count: 7 },
    })
    assert.equal(guestDisband.statusCode, 403)
    assert.equal(getRoom(room.room_number), room)

    const hostDisband = await fastify.inject({
        method: "POST",
        url: "/disband_room",
        payload: { viewer_id: 101, room_number: room.room_number, api_count: 8 },
    })
    assert.equal(hostDisband.statusCode, 200)
    assert.equal(getRoom(room.room_number), undefined)
})
