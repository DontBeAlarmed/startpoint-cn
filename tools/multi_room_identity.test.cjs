const assert = require("node:assert/strict")
const Fastify = require("fastify")
const fs = require("node:fs")
const path = require("node:path")
const { pack, unpack } = require("msgpackr")
const test = require("node:test")

require("ts-node/register/transpile-only")

async function captureConsole(callback) {
    const entries = []
    const originals = {}
    for (const method of ["log", "warn", "error"]) {
        originals[method] = console[method]
        console[method] = (...args) => entries.push(args.map(value => {
            if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ""}`
            return typeof value === "string" ? value : JSON.stringify(value)
        }).join(" "))
    }
    try {
        await callback()
    } finally {
        for (const method of ["log", "warn", "error"]) console[method] = originals[method]
    }
    return entries.join("\n")
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

stubModule("../src/utils", {
    getServerTime: () => 1_725_000_000,
    generateDataHeaders: ({ viewer_id, result_code } = {}) => ({
        viewer_id: viewer_id ?? 0,
        result_code: result_code ?? 1,
    }),
})

const players = new Map([
    [101, { playerId: 201, player: { id: 201, name: "Host", rankPoint: 0, leaderCharacterId: 401 } }],
    [202, { playerId: 302, player: { id: 302, name: "Guest", rankPoint: 0, leaderCharacterId: 402 } }],
    [303, { playerId: 403, player: { id: 403, name: "Stranger", rankPoint: 0, leaderCharacterId: 403 } }],
])
const TEST_COMPATIBILITY = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "embedded",
    RES_VER: "embedded",
    cdnTargetVersion: "embedded",
    contentDigest: `sha256:${"0".repeat(64)}`,
    modeDigest: `sha256:${"0".repeat(64)}`,
})
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
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { registerSocialRoutes } = require("../src/multi/http/social")

async function createRouteServer(options = {}) {
    const fastify = Fastify()
    const context = options.context ?? createEmbeddedMultiHttpContext({
        compatibility: TEST_COMPATIBILITY,
        resolvePlayerContext: options.resolvePlayerContext
            ?? (async viewerId => players.get(viewerId) ?? null),
        prepareAdmission: async viewerId => {
            const local = players.get(viewerId)
            return local ? {
                snapshot: snapshotFixture(viewerId, local.player.name),
            } : null
        },
    })
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    registerLobbyRoutes(fastify, context)
    registerRoomRoutes(fastify, context)
    registerSocialRoutes(fastify, context)
    await fastify.ready()
    return fastify
}

function snapshotFixture(viewerId, name = `Player${viewerId}`) {
    return {
        viewerId,
        name,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 401,
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

test("room HTTP routes depend on the injected context instead of global room access", () => {
    const root = path.resolve(__dirname, "..")
    for (const relativePath of [
        "src/multi/http/lobby.ts",
        "src/multi/http/room.ts",
        "src/multi/http/social.ts",
    ]) {
        const source = fs.readFileSync(path.join(root, relativePath), "utf8")
        assert.doesNotMatch(source, /from "\.\.\/room\/manager"/)
        assert.doesNotMatch(source, /from "\.\.\/state\/SessionManager"/)
        assert.doesNotMatch(source, /\bresolveMultiPlayerContext\b/)
    }
    assert.doesNotMatch(
        fs.readFileSync(path.join(root, "src/multi/http/lobby.ts"), "utf8"),
        /\bgetSession\b/,
    )
})

test("room routes derive raising state from the injected coordinator status", async t => {
    const participant = viewerId => ({ nodeSessionId: "test-node", viewerId })
    const compatibility = TEST_COMPATIBILITY
    const status = {
        roomNumber: "123456",
        accessToken: "test-token",
        category: 1,
        questId: 701,
        hostEntryTime: 1_725_000_000,
        roomSequence: 1,
        raisingState: 7,
        shareRoomOptions: 0,
        hostMainCharacterId: 401,
        isNpcMode: false,
        hostOnline: false,
        host: participant(101),
        members: [participant(101), participant(202)],
        compatibility,
    }
    const ok = value => Promise.resolve({ ok: true, value })
    const admissionRegistry = new AdmissionRegistry({ now: () => 1_000 })
    const context = {
        coordinator: {
            selectRoom: () => ok(status),
            prepareRoom: () => ok(status),
            getRoomStatus: () => ok(status),
        },
        resolvePlayerContext: async viewerId => players.get(viewerId) ?? null,
        snapshotProvider: {
            getParticipant: participant,
            getCompatibility: () => ({ ok: true, value: compatibility }),
            prepareAdmission: async viewerId => ({ snapshot: snapshotFixture(viewerId) }),
        },
        questAvailability: {
            check: () => ({ available: true }),
        },
        admissionProvider: admissionRegistry,
        admissionIssuer: admissionRegistry,
        admissionTtlMs: 5_000,
        now: () => 1_000,
        settlementVerifier: {},
    }
    const originalIsHostOnline = sessionManager.isHostOnline
    sessionManager.isHostOnline = () => true
    t.after(() => { sessionManager.isHostOnline = originalIsHostOnline })

    const fastify = await createRouteServer({ context })
    t.after(async () => fastify.close())

    const routes = [
        {
            name: "select",
            url: "/select_room",
            payload: { room_number: status.roomNumber, category: 1, quest_id: 701 },
        },
        {
            name: "prepare",
            url: "/prepare",
            payload: { room_number: status.roomNumber, category: 1, quest_id: 701 },
        },
        {
            name: "restore",
            url: "/restore_room",
            payload: { room_number: status.roomNumber, room_sequence: 1 },
        },
    ]
    for (const route of routes) {
        for (const [role, viewerId, expectedState] of [
            ["guest", 202, 2],
            ["host", 101, 1],
        ]) {
            await t.test(`${route.name}: ${role}`, async () => {
                const response = await fastify.inject({
                    method: "POST",
                    url: route.url,
                    payload: { ...route.payload, viewer_id: viewerId, api_count: 1 },
                })
                assert.equal(response.statusCode, 200)
                assert.equal(decode(response).data.raising_state, expectedState)
                if (route.name === "prepare") {
                    assert.equal(
                        admissionRegistry.consume(status.roomNumber, viewerId)?.snapshot.viewerId,
                        viewerId,
                    )
                }
            })
        }
    }
})

test("lobby routes reject string viewer ids before resolving player context", async t => {
    let resolverCalls = 0
    const fastify = await createRouteServer({
        resolvePlayerContext: async viewerId => {
            resolverCalls++
            return players.get(Number(viewerId)) ?? null
        },
    })
    t.after(async () => fastify.close())

    const cases = [
        {
            name: "get_rooms",
            url: "/get_rooms",
            payload: { viewer_id: "101", category_id: 1, party_id: 1, api_count: 1 },
        },
        {
            name: "create_room",
            url: "/create_room",
            payload: {
                viewer_id: "101",
                party_id: 1,
                category: 1,
                quest_id: 701,
                api_count: 2,
            },
        },
        {
            name: "search_room",
            url: "/search_room",
            payload: { viewer_id: "101", room_number: "000000", api_count: 3 },
        },
        {
            name: "select_room",
            url: "/select_room",
            payload: {
                viewer_id: "101",
                room_number: "000000",
                party_id: 1,
                category: 1,
                quest_id: 701,
                accepted_type: 0,
                api_count: 4,
            },
        },
    ]

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const response = await fastify.inject({
                method: "POST",
                url: entry.url,
                payload: entry.payload,
            })
            assert.equal(response.statusCode, 400)
        })
    }
    assert.equal(resolverCalls, 0)
})

test("lobby, room and social reject invalid viewer ids before resolving player context", async t => {
    let resolverCalls = 0
    const fastify = await createRouteServer({
        resolvePlayerContext: async viewerId => {
            resolverCalls++
            return players.get(Number(viewerId)) ?? null
        },
    })
    t.after(async () => fastify.close())

    const routes = [
        {
            name: "lobby",
            url: "/get_rooms",
            payload: { category_id: 1, party_id: 1, api_count: 1 },
        },
        {
            name: "room",
            url: "/prepare",
            payload: { room_number: "000000", category: 1, quest_id: 701, api_count: 2 },
        },
        {
            name: "social",
            url: "/verify_access_token",
            payload: { access_token: "missing-token", api_count: 3 },
        },
    ]
    const invalidViewerIds = [
        ["string", "101"],
        ["NaN", Number.NaN],
        ["non-integer", 101.5],
        ["zero", 0],
        ["negative", -1],
    ]

    for (const route of routes) {
        for (const [label, viewerId] of invalidViewerIds) {
            await t.test(`${route.name}: ${label}`, async () => {
                const response = await fastify.inject({
                    method: "POST",
                    url: route.url,
                    payload: { ...route.payload, viewer_id: viewerId },
                })
                assert.equal(response.statusCode, 400)
            })
        }
    }
    assert.equal(resolverCalls, 0)
})

test("room route logs never echo unvalidated room payloads", async t => {
    const fastify = await createRouteServer()
    t.after(async () => fastify.close())
    const roomSentinel = "ROOM_TOKEN_SENTINEL_HTTP_ROUTE"

    const output = await captureConsole(async () => {
        for (const url of ["/prepare", "/summon", "/restore_room", "/share_room", "/disband_room"]) {
            const response = await fastify.inject({
                method: "POST",
                url,
                payload: {
                    viewer_id: "invalid-viewer",
                    room_number: roomSentinel,
                    category: 1,
                    category_id: 1,
                    quest_id: 701,
                    api_count: 1,
                },
            })
            assert.equal(response.statusCode, 400, url)
        }
    })

    assert.doesNotMatch(output, new RegExp(roomSentinel))
    for (const event of ["prepare", "summon", "restore_room", "share_room", "disband_room"]) {
        assert.match(output, new RegExp(`\\[MULTI\\] ${event} received`))
    }
})

test("valid viewers cannot leak missing room lookups through the coordinator", async t => {
    const fastify = await createRouteServer()
    t.after(async () => fastify.close())
    const roomSentinel = "ROOM_TOKEN_SENTINEL_MANAGER_MISS"
    const cases = [
        ["/search_room", 200, { category: 1, quest_id: 701 }],
        ["/select_room", 200, { party_id: 1, category: 1, quest_id: 701 }],
        ["/prepare", 200, { category: 1, quest_id: 701 }],
        ["/summon", 400, { category_id: 1, quest_id: 701 }],
        ["/restore_room", 200, { room_sequence: 1 }],
        ["/share_room", 403, {}],
        ["/disband_room", 403, {}],
    ]

    const output = await captureConsole(async () => {
        for (const [url, statusCode, extraPayload] of cases) {
            const response = await fastify.inject({
                method: "POST",
                url,
                payload: {
                    viewer_id: 202,
                    room_number: roomSentinel,
                    api_count: 1,
                    ...extraPayload,
                },
            })
            assert.equal(response.statusCode, statusCode, url)
        }
    })

    assert.doesNotMatch(output, new RegExp(roomSentinel))
    assert.equal(
        output.match(/\[MULTI\] room lookup missed/g)?.length,
        cases.length,
    )
})

test("stateless social routes reject invalid viewer ids without resolving player context", async t => {
    let resolverCalls = 0
    const fastify = await createRouteServer({
        resolvePlayerContext: async () => {
            resolverCalls++
            return null
        },
    })
    t.after(async () => fastify.close())

    for (const url of ["/micro_community", "/publish_room"]) {
        for (const viewerId of ["101", Number.NaN, 101.5, 0, -1]) {
            await t.test(`${url}: ${String(viewerId)}`, async () => {
                const response = await fastify.inject({
                    method: "POST",
                    url,
                    payload: { viewer_id: viewerId, api_count: 1 },
                })
                assert.equal(response.statusCode, 400)
            })
        }
    }
    assert.equal(resolverCalls, 0)
})

test("create, search, select and prepare preserve room response contracts through the coordinator", async t => {
    const fastify = await createRouteServer()
    t.after(async () => fastify.close())

    const createResponse = await fastify.inject({
        method: "POST",
        url: "/create_room",
        payload: { viewer_id: 101, party_id: 1, category: 1, quest_id: 701, api_count: 1 },
    })
    assert.equal(createResponse.statusCode, 200)
    const created = decode(createResponse).data
    assert.match(created.access_token, /^[A-Za-z0-9_-]{32,}$/)
    assert.match(created.room_number, /^\d{6}$/)
    assert.equal(created.room_url, "")
    t.after(() => disbandRoom(created.room_number))

    const searchResponse = await fastify.inject({
        method: "POST",
        url: "/search_room",
        payload: { viewer_id: 202, room_number: created.room_number, api_count: 2 },
    })
    assert.deepEqual(decode(searchResponse).data, {
        room_exists: true,
        category_id: 1,
        quest_id: 701,
        room_number: created.room_number,
        establisher_viewer_id: 101,
        establisher_follow: 0,
    })

    for (const [url, locator, expectedState] of [
        ["/select_room", { room_number: created.room_number }, 2],
        ["/select_room", { access_token: created.access_token }, 2],
        ["/prepare", { room_number: created.room_number }, 2],
        ["/prepare", { access_token: created.access_token }, 2],
    ]) {
        const response = await fastify.inject({
            method: "POST",
            url,
            payload: {
                viewer_id: 202,
                party_id: 1,
                category: 1,
                quest_id: 701,
                api_count: 3,
                ...locator,
            },
        })
        assert.equal(response.statusCode, 200, `${url} ${JSON.stringify(locator)}`)
        const data = decode(response).data
        assert.equal(data.room_number, created.room_number)
        assert.equal(data.category_id, 1)
        assert.equal(data.quest_id, 701)
        assert.equal(data.raising_state, expectedState)
    }
})

test("empty room locators preserve legacy HTTP responses", async t => {
    const fastify = await createRouteServer()
    t.after(async () => fastify.close())

    const cases = [
        {
            name: "search_room",
            url: "/search_room",
            payload: { viewer_id: 202, room_number: "", api_count: 1 },
            statusCode: 200,
            expectedExists: false,
        },
        {
            name: "select_room",
            url: "/select_room",
            payload: {
                viewer_id: 202,
                room_number: "",
                access_token: "",
                party_id: 1,
                category: 1,
                quest_id: 701,
                api_count: 2,
            },
            statusCode: 200,
            expectedState: 9,
        },
        {
            name: "prepare",
            url: "/prepare",
            payload: {
                viewer_id: 202,
                room_number: "",
                access_token: "",
                category: 1,
                quest_id: 701,
                api_count: 3,
            },
            statusCode: 200,
            expectedState: 9,
        },
        {
            name: "verify_access_token",
            url: "/verify_access_token",
            payload: { viewer_id: 202, access_token: "", api_count: 4 },
            statusCode: 200,
            expectedData: { room_exists: false },
        },
        {
            name: "summon",
            url: "/summon",
            payload: {
                viewer_id: 101,
                room_number: "",
                category_id: 1,
                quest_id: 701,
                api_count: 5,
            },
            statusCode: 400,
        },
        {
            name: "restore_room",
            url: "/restore_room",
            payload: { viewer_id: 202, room_number: "", api_count: 6 },
            statusCode: 200,
            expectedState: 9,
        },
        {
            name: "share_room",
            url: "/share_room",
            payload: { viewer_id: 101, room_number: "", api_count: 7 },
            statusCode: 403,
        },
        {
            name: "disband_room",
            url: "/disband_room",
            payload: { viewer_id: 101, room_number: "", api_count: 8 },
            statusCode: 403,
        },
    ]

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const response = await fastify.inject({
                method: "POST",
                url: entry.url,
                payload: entry.payload,
            })
            assert.equal(response.statusCode, entry.statusCode)
            if (entry.expectedData) {
                assert.deepEqual(decode(response).data, entry.expectedData)
            }
            if (entry.expectedExists !== undefined) {
                assert.equal(decode(response).data.room_exists, entry.expectedExists)
            }
            if (entry.expectedState !== undefined) {
                assert.equal(decode(response).data.raising_state, entry.expectedState)
            }
        })
    }
})

test("create_room maps invalid coordinator numeric fields to HTTP 400", async t => {
    const fastify = await createRouteServer()
    t.after(async () => fastify.close())

    for (const [field, value] of [
        ["party_id", 0],
        ["category", 0],
        ["quest_id", 0],
    ]) {
        await t.test(field, async () => {
            const payload = {
                viewer_id: 101,
                party_id: 1,
                category: 1,
                quest_id: 701,
                api_count: 1,
                [field]: value,
            }
            const response = await fastify.inject({
                method: "POST",
                url: "/create_room",
                payload,
            })
            assert.equal(response.statusCode, 400)
        })
    }
})

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

test("compatibility and local quest failures short-circuit room mutations", async t => {
    const participant = viewerId => ({ nodeSessionId: "test-node", viewerId })
    const compatibility = {
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "1.4.54",
        cdnTargetVersion: "1.4.54",
        contentDigest: `sha256:${"1".repeat(64)}`,
        modeDigest: `sha256:${"2".repeat(64)}`,
    }
    const status = {
        roomNumber: "123456",
        accessToken: "test-token",
        category: 1,
        questId: 701,
        hostEntryTime: 1_725_000_000,
        roomSequence: 1,
        raisingState: 2,
        shareRoomOptions: 0,
        hostMainCharacterId: 401,
        isNpcMode: false,
        hostOnline: true,
        host: participant(101),
        members: [participant(101)],
        compatibility,
    }
    let coordinatorCalls = 0
    let prepareCalls = 0
    let admissionCalls = 0
    let compatibilityResult = { ok: false, error: "INCOMPATIBLE_ROOM" }
    let questResult = { available: true }
    const found = async () => {
        coordinatorCalls++
        return { ok: true, value: status }
    }
    const context = {
        coordinator: {
            createRoom: async () => {
                coordinatorCalls++
                return { ok: true, value: status }
            },
            searchRoom: found,
            selectRoom: found,
            prepareRoom: async () => {
                prepareCalls++
                return { ok: true, value: status }
            },
        },
        resolvePlayerContext: async viewerId => players.get(viewerId) ?? null,
        snapshotProvider: {
            getParticipant: participant,
            getCompatibility: () => compatibilityResult,
            prepareAdmission: async viewerId => ({ snapshot: snapshotFixture(viewerId) }),
        },
        questAvailability: {
            check: () => questResult,
        },
        admissionProvider: {},
        admissionIssuer: {
            issue: () => {
                admissionCalls++
                return { ok: true, value: undefined }
            },
        },
        admissionTtlMs: 5_000,
        now: () => 1_000,
        settlementVerifier: {},
    }
    const fastify = await createRouteServer({ context })
    t.after(async () => fastify.close())

    for (const [url, payload] of [
        ["/create_room", { party_id: 1, category: 1, quest_id: 701 }],
        ["/search_room", { room_number: status.roomNumber }],
        ["/select_room", { room_number: status.roomNumber }],
        ["/prepare", { room_number: status.roomNumber, category: 1, quest_id: 701 }],
        ["/verify_access_token", { access_token: status.accessToken }],
    ]) {
        await fastify.inject({
            method: "POST",
            url,
            payload: { viewer_id: 202, api_count: 1, ...payload },
        })
    }
    assert.equal(coordinatorCalls, 0, "invalid compatibility must not reach the coordinator")
    assert.equal(prepareCalls, 0)
    assert.equal(admissionCalls, 0)

    compatibilityResult = { ok: true, value: compatibility }
    questResult = { available: false, code: "QUEST_NOT_AVAILABLE" }
    const create = await fastify.inject({
        method: "POST",
        url: "/create_room",
        payload: { viewer_id: 202, party_id: 1, category: 1, quest_id: 701, api_count: 2 },
    })
    assert.equal(create.statusCode, 400)
    assert.equal(coordinatorCalls, 0, "unavailable host quest must not create a room")

    const search = await fastify.inject({
        method: "POST",
        url: "/search_room",
        payload: { viewer_id: 202, room_number: status.roomNumber, api_count: 3 },
    })
    assert.equal(decode(search).data_headers.result_code, 4020)

    const select = await fastify.inject({
        method: "POST",
        url: "/select_room",
        payload: { viewer_id: 202, room_number: status.roomNumber, api_count: 4 },
    })
    assert.equal(decode(select).data.raising_state, 7)

    const prepare = await fastify.inject({
        method: "POST",
        url: "/prepare",
        payload: {
            viewer_id: 202,
            room_number: status.roomNumber,
            category: 1,
            quest_id: 701,
            api_count: 5,
        },
    })
    assert.equal(decode(prepare).data_headers.result_code, 4507)
    assert.equal("raising_state" in decode(prepare).data, false)

    const verify = await fastify.inject({
        method: "POST",
        url: "/verify_access_token",
        payload: { viewer_id: 202, access_token: status.accessToken, api_count: 6 },
    })
    assert.equal(decode(verify).data_headers.result_code, 4020)
    assert.equal(prepareCalls, 0, "quest rejection must happen before prepareRoom")
    assert.equal(admissionCalls, 0, "quest rejection must not issue admission")
})

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
    const hostClient = sessionManager.createClient(socket, 101, room.room_number, "host-cid")
    hostClient.participant = { nodeSessionId: "embedded", viewerId: 101 }
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

    room.host_entry_time = 1_700_000_000
    const mismatchedPrepare = await fastify.inject({
        method: "POST",
        url: "/prepare",
        payload: { viewer_id: 303, room_number: room.room_number, category: 1, quest_id: 999, api_count: 3 },
    })
    assert.equal(mismatchedPrepare.statusCode, 400)
    assert.equal(room.host_entry_time, 1_700_000_000)

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
    assert.deepEqual(guestDisband.json(), {
        error: "Forbidden",
        message: "Room permission denied.",
    })
    assert.equal(getRoom(room.room_number), room)

    const hostDisband = await fastify.inject({
        method: "POST",
        url: "/disband_room",
        payload: { viewer_id: 101, room_number: room.room_number, api_count: 8 },
    })
    assert.equal(hostDisband.statusCode, 200)
    assert.equal(getRoom(room.room_number), undefined)
})
