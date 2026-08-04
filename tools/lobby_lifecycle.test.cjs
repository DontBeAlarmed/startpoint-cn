const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { sessionManager } = require("../src/multi/state/SessionManager")
const { addRoomMember, createRoom, disbandRoom, getRoom, isRoomMember } = require("../src/multi/room/manager")
let lobbyLifecycle = {}
try {
    lobbyLifecycle = require("../src/multi/tcp/lobby-lifecycle")
} catch {
    // RED: lifecycle module does not exist yet.
}
const { getLobbyLifecycleStatus, startLobbyLifecycle, stopLobbyLifecycle } = lobbyLifecycle
const { handleMessage } = require("../src/multi/tcp/lobby")
const { NpcMateProvider } = require("../src/multi/npc/controller")

function deferred() {
    let resolve
    const promise = new Promise(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

function flushPromises() {
    return new Promise(resolve => setImmediate(resolve))
}

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
    }

    write() { return true }
    destroy() {
        this.destroyed = true
        this.writable = false
    }
}

function startCapturedLobbyLifecycle() {
    const timers = []
    startLobbyLifecycle({
        createTimer(callback, delayMs) {
            const timer = { callback, delayMs, unref() {} }
            timers.push(timer)
            return timer
        },
        clearTimer() {},
    })
    return timers
}

function createLobbyClient(room, viewerId, connectionId) {
    const socket = new FakeSocket()
    const client = sessionManager.createClient(socket, viewerId, room.room_number, connectionId)
    client.yourself = {
        viewerId,
        connectionId,
        party: {},
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    return { client, socket }
}

function createLobbyRoom(t, hostViewerId, guestViewerIds = []) {
    const room = createRoom(hostViewerId, hostViewerId + 1000, 1, 1, hostViewerId + 2000, 1, hostViewerId + 3000)
    const host = createLobbyClient(room, hostViewerId, `host-${hostViewerId}`)
    const guests = guestViewerIds.map(viewerId => createLobbyClient(room, viewerId, `guest-${viewerId}`))
    t.after(() => {
        for (const entry of [...guests].reverse()) sessionManager.removeClientBySocket(entry.socket)
        sessionManager.removeClientBySocket(host.socket)
        disbandRoom(room.room_number)
    })
    return { room, host, guests }
}

function stubRecruitment(t, recruitedMates) {
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    let calls = 0
    NpcMateProvider.prototype.onRecruit = async () => {
        calls++
        return { recruitedMates }
    }
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })
    return () => calls
}

test.afterEach(() => {
    if (typeof stopLobbyLifecycle === "function") stopLobbyLifecycle()
})

test("lobby does not read player storage or persist TCP party changes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/multi/tcp/lobby.ts"), "utf8")
    assert.doesNotMatch(source, /data\/domains\/(party|player)/)
    assert.doesNotMatch(source, /buildRealParty/)
    assert.doesNotMatch(source, /updatePlayerSync/)
})

test("an explicit guest Bye releases the persistent room membership", t => {
    const { room, guests } = createLobbyRoom(t, 500, [600])
    const guest = guests[0]
    addRoomMember(room.room_number, guest.client.viewerId)
    assert.equal(isRoomMember(room, guest.client.viewerId), true)

    handleMessage(guest.socket, [0, [1]])

    assert.equal(isRoomMember(room, guest.client.viewerId), false)
})

test("a transport disconnect preserves the room for restore", t => {
    const { room, host } = createLobbyRoom(t, 499)

    sessionManager.removeClient(host.client)

    assert.equal(getRoom(room.room_number), room)
})

test("an explicit host Bye disbands the room even while guests remain", t => {
    const { room, host } = createLobbyRoom(t, 498, [598])

    handleMessage(host.socket, [0, [1]])

    assert.equal(getRoom(room.room_number), undefined)
})

test("all three lobby timeout paths are unrefed, cancelled, and inert after stop", async t => {
    assert.equal(typeof startLobbyLifecycle, "function")
    assert.equal(typeof stopLobbyLifecycle, "function")
    assert.equal(typeof getLobbyLifecycleStatus, "function")
    const timers = []
    const cleared = []
    const createTimer = (callback, delayMs) => {
        const timer = {
            callback,
            delayMs,
            unrefCalls: 0,
            unref() { this.unrefCalls++ },
        }
        timers.push(timer)
        return timer
    }
    startLobbyLifecycle({
        createTimer,
        clearTimer(timer) { cleared.push(timer) },
    })

    const room = createRoom(501, 601, 1, 1, 701, 1, 801)
    room.npc_count = 2
    const socket = new FakeSocket()
    const client = sessionManager.createClient(socket, 501, room.room_number, "lobby-timer-cid")
    client.yourself = {
        viewerId: 501,
        connectionId: "lobby-timer-cid",
        party: {},
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    t.after(() => {
        sessionManager.removeClientBySocket(socket)
        disbandRoom(room.room_number)
    })

    handleMessage(socket, [0, [10, [{ name: "NPC1" }, { name: "NPC2" }]]])
    await new Promise(resolve => setImmediate(resolve))
    handleMessage(socket, [0, [0, { party: {} }]])

    assert.equal(timers.length, 3)
    assert.deepEqual(timers.map(timer => timer.unrefCalls), [1, 1, 1])
    assert.deepEqual(getLobbyLifecycleStatus(), { running: true, activeTimers: 3 })

    const originalSendJson = sessionManager.sendJson
    const originalBroadcast = sessionManager.broadcastToRoom
    let sideEffects = 0
    sessionManager.sendJson = () => { sideEffects++ }
    sessionManager.broadcastToRoom = () => { sideEffects++ }
    try {
        stopLobbyLifecycle()
        assert.deepEqual(cleared, timers)
        assert.deepEqual(getLobbyLifecycleStatus(), { running: false, activeTimers: 0 })
        for (const timer of timers) timer.callback()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(sideEffects, 0)
    } finally {
        sessionManager.sendJson = originalSendJson
        sessionManager.broadcastToRoom = originalBroadcast
    }
})

test("an async lobby timer callback cannot mutate state after its generation stops", async t => {
    const timers = []
    startLobbyLifecycle({
        createTimer(callback) {
            const timer = { callback, unref() {} }
            timers.push(timer)
            return timer
        },
        clearTimer() {},
    })

    const room = createRoom(502, 602, 1, 1, 702, 1, 802)
    room.npc_count = 2
    const socket = new FakeSocket()
    const client = sessionManager.createClient(socket, 502, room.room_number, "async-lobby-cid")
    client.yourself = {
        viewerId: 502,
        connectionId: "async-lobby-cid",
        party: {},
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    t.after(() => {
        sessionManager.removeClientBySocket(socket)
        disbandRoom(room.room_number)
    })

    const recruitment = deferred()
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    NpcMateProvider.prototype.onRecruit = () => recruitment.promise
    try {
        handleMessage(socket, [0, [0, { party: {} }]])
        assert.equal(timers.length, 1)
        timers[0].callback()
        await new Promise(resolve => setImmediate(resolve))

        stopLobbyLifecycle()
        startLobbyLifecycle()
        recruitment.resolve({
            recruitedMates: [
                { viewer_id: 900000001, com_id: 1 },
                { viewer_id: 900000002, com_id: 2 },
            ],
        })
        await new Promise(resolve => setImmediate(resolve))

        assert.equal(client.mates.length, 1)
        assert.equal(timers.length, 1)
    } finally {
        NpcMateProvider.prototype.onRecruit = originalOnRecruit
    }
})

test("EnterComs ignores client aliases and joins roster names to provider identities by com_id", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 510)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "贡献者甲" },
        { com_id: 2, name: "贡献者乙" },
    ]
    stubRecruitment(t, [
        { viewer_id: 920000002, com_id: 2 },
        { viewer_id: 920000001, com_id: 1 },
    ])

    handleMessage(host.socket, [0, [10, [{ name: "客户端甲" }, { name: "客户端乙" }]]])
    await flushPromises()

    assert.deepEqual(
        host.client.mates.filter(mate => mate.comId).map(mate => ({
            comId: mate.comId,
            viewerId: mate.viewerId,
            name: mate.name,
        })),
        [
            { comId: 1, viewerId: 920000001, name: "贡献者甲" },
            { comId: 2, viewerId: 920000002, name: "贡献者乙" },
        ],
    )
})

test("repeated EnterComs preserves the room com_id to contributor-name binding", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 511)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "固定甲" },
        { com_id: 2, name: "固定乙" },
    ]
    stubRecruitment(t, [
        { viewer_id: 930000001, com_id: 1 },
        { viewer_id: 930000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, [{ name: "第一次甲" }, { name: "第一次乙" }]]])
    await flushPromises()
    const firstBinding = new Map(host.client.mates.filter(mate => mate.comId).map(mate => [mate.comId, mate.name]))

    handleMessage(host.socket, [0, [10, [{ name: "第二次甲" }, { name: "第二次乙" }]]])
    await flushPromises()
    const secondBinding = new Map(host.client.mates.filter(mate => mate.comId).map(mate => [mate.comId, mate.name]))

    assert.deepEqual(firstBinding, new Map([[1, "固定甲"], [2, "固定乙"]]))
    assert.deepEqual(secondBinding, firstBinding)
})

test("a second real player leaves only roster com_id 2 active and the room capped at three", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 512, [612])
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "被替换" },
        { com_id: 2, name: "保留昵称" },
    ]
    stubRecruitment(t, [
        { viewer_id: 940000001, com_id: 1 },
        { viewer_id: 940000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, [{ name: "客户端甲" }, { name: "客户端乙" }]]])
    await flushPromises()

    assert.equal(host.client.mates.length, 3)
    assert.deepEqual(
        host.client.mates.filter(mate => mate.comId).map(mate => ({
            comId: mate.comId,
            viewerId: mate.viewerId,
            name: mate.name,
        })),
        [{ comId: 2, viewerId: 940000002, name: "保留昵称" }],
    )
})

test("three connected real players skip NPC recruitment and remain a three-mate room", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 513, [613, 713])
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "不会加入甲" },
        { com_id: 2, name: "不会加入乙" },
    ]
    const getRecruitCalls = stubRecruitment(t, [
        { viewer_id: 950000001, com_id: 1 },
        { viewer_id: 950000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, [{ name: "客户端甲" }, { name: "客户端乙" }]]])
    await flushPromises()

    assert.equal(getRecruitCalls(), 0)
    assert.equal(host.client.mates.length, 3)
    assert.equal(host.client.mates.filter(mate => mate.comId).length, 0)
})

test("automatic rematch recruitment restores contributor names without hardcoded aliases", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 514)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "重赛甲" },
        { com_id: 2, name: "重赛乙" },
    ]
    stubRecruitment(t, [
        { viewer_id: 960000001, com_id: 1 },
        { viewer_id: 960000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [0, { party: {} }]])
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delayMs, 500)
    timers[0].callback()
    await flushPromises()

    assert.deepEqual(
        host.client.mates.filter(mate => mate.comId).map(mate => mate.name),
        ["重赛甲", "重赛乙"],
    )
})

test("first EnterComs assigns one stable roster synchronously before recruitment awaits", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 515)
    const recruitment = deferred()
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    NpcMateProvider.prototype.onRecruit = () => recruitment.promise
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })

    handleMessage(host.socket, [0, [10, [{ name: "客户端甲" }, { name: "客户端乙" }]]])
    const firstRoster = room.npc_roster.map(assignment => ({ ...assignment }))
    handleMessage(host.socket, [0, [10, [{ name: "另一甲" }, { name: "另一乙" }]]])

    assert.equal(room.npc_count, 2)
    assert.equal(firstRoster.length, 2)
    assert.deepEqual(room.npc_roster, firstRoster)

    recruitment.resolve({
        recruitedMates: [
            { viewer_id: 970000001, com_id: 1 },
            { viewer_id: 970000002, com_id: 2 },
        ],
    })
    await flushPromises()
})

test("a guest entering while recruitment awaits survives the current NPC commit", async t => {
    startCapturedLobbyLifecycle()
    const { room, host, guests } = createLobbyRoom(t, 516)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "异步甲" },
        { com_id: 2, name: "异步乙" },
    ]
    const recruitment = deferred()
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    NpcMateProvider.prototype.onRecruit = () => recruitment.promise
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })

    handleMessage(host.socket, [0, [10, []]])

    const guest = createLobbyClient(room, 616, "guest-616")
    guests.push(guest)
    handleMessage(guest.socket, [0, [0, { party: { source: "guest" } }]])

    recruitment.resolve({
        recruitedMates: [
            { viewer_id: 980000001, com_id: 1 },
            { viewer_id: 980000002, com_id: 2 },
        ],
    })
    await flushPromises()

    assert.equal(host.client.mates.length, 3)
    assert.deepEqual(
        host.client.mates.map(mate => ({ viewerId: mate.viewerId, comId: mate.comId ?? 0 })),
        [
            { viewerId: 516, comId: 0 },
            { viewerId: 616, comId: 0 },
            { viewerId: 980000002, comId: 2 },
        ],
    )
    assert.deepEqual(room.mates, [
        { viewer_id: 516, com_id: 0 },
        { viewer_id: 616, com_id: 0 },
        { viewer_id: 980000002, com_id: 2 },
    ])
})

test("repeated EnterComs only lets the latest recruitment timers broadcast", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 517)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "并发甲" },
        { com_id: 2, name: "并发乙" },
    ]
    const recruitments = [deferred(), deferred()]
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    let recruitIndex = 0
    NpcMateProvider.prototype.onRecruit = () => recruitments[recruitIndex++].promise
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })

    handleMessage(host.socket, [0, [10, []]])
    recruitments[0].resolve({
        recruitedMates: [
            { viewer_id: 981000001, com_id: 1 },
            { viewer_id: 981000002, com_id: 2 },
        ],
    })
    await flushPromises()
    assert.equal(timers.length, 2)

    handleMessage(host.socket, [0, [10, []]])
    recruitments[1].resolve({
        recruitedMates: [
            { viewer_id: 982000001, com_id: 1 },
            { viewer_id: 982000002, com_id: 2 },
        ],
    })
    await flushPromises()

    const originalSendJson = sessionManager.sendJson
    const originalBroadcast = sessionManager.broadcastToRoom
    const npcReadyIds = []
    let joinMessages = 0
    sessionManager.sendJson = (_socket, data) => {
        if (data?.[1]?.[0] === 1) joinMessages++
    }
    sessionManager.broadcastToRoom = (_roomNumber, data) => {
        if (data?.[1]?.[0] === 2 && String(data[1][1]).includes("-npc-")) {
            npcReadyIds.push(data[1][1])
        }
    }
    try {
        for (const timer of timers) timer.callback()
    } finally {
        sessionManager.sendJson = originalSendJson
        sessionManager.broadcastToRoom = originalBroadcast
    }

    assert.equal(timers.length, 4)
    assert.equal(joinMessages, 1)
    assert.deepEqual(npcReadyIds, [
        `${room.room_number}-npc-1`,
        `${room.room_number}-npc-2`,
    ])
    assert.deepEqual(
        host.client.mates.filter(mate => mate.comId).map(mate => mate.viewerId),
        [982000001, 982000002],
    )
})

test("a full real-player room strips existing NPCs before skipping recruitment", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host, guests } = createLobbyRoom(t, 520)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "待替换甲" },
        { com_id: 2, name: "待替换乙" },
    ]
    const getRecruitCalls = stubRecruitment(t, [
        { viewer_id: 985000001, com_id: 1 },
        { viewer_id: 985000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()
    assert.equal(host.client.mates.length, 3)
    assert.equal(host.client.mates.filter(mate => mate.comId).length, 2)
    assert.equal(timers.length, 2)

    const firstGuest = createLobbyClient(room, 620, "guest-620")
    const secondGuest = createLobbyClient(room, 720, "guest-720")
    guests.push(firstGuest, secondGuest)

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()

    assert.equal(getRecruitCalls(), 1)
    assert.equal(timers.length, 2)
    assert.deepEqual(
        host.client.mates.map(mate => ({ viewerId: mate.viewerId, comId: mate.comId ?? 0 })),
        [
            { viewerId: 520, comId: 0 },
            { viewerId: 620, comId: 0 },
            { viewerId: 720, comId: 0 },
        ],
    )
    assert.deepEqual(room.mates, [
        { viewer_id: 520, com_id: 0 },
        { viewer_id: 620, com_id: 0 },
        { viewer_id: 720, com_id: 0 },
    ])

    const originalSendJson = sessionManager.sendJson
    const originalBroadcast = sessionManager.broadcastToRoom
    let npcJoinMessages = 0
    let npcReadyMessages = 0
    sessionManager.sendJson = (_socket, data) => {
        if (data?.[1]?.[0] === 1) npcJoinMessages++
    }
    sessionManager.broadcastToRoom = (_roomNumber, data) => {
        if (data?.[1]?.[0] === 2 && String(data[1][1]).includes("-npc-")) {
            npcReadyMessages++
        }
    }
    try {
        for (const timer of timers) timer.callback()
    } finally {
        sessionManager.sendJson = originalSendJson
        sessionManager.broadcastToRoom = originalBroadcast
    }

    assert.equal(npcJoinMessages, 0)
    assert.equal(npcReadyMessages, 0)
})

test("EnterComs caps four connected real players at three without a negative npc_count", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 521, [621, 721, 821])
    const getRecruitCalls = stubRecruitment(t, [
        { viewer_id: 986000001, com_id: 1 },
        { viewer_id: 986000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()

    assert.equal(getRecruitCalls(), 0)
    assert.equal(room.npc_count, 0)
    assert.deepEqual(
        host.client.mates.map(mate => mate.viewerId),
        [521, 621, 721],
    )
    assert.deepEqual(room.mates, [
        { viewer_id: 521, com_id: 0 },
        { viewer_id: 621, com_id: 0 },
        { viewer_id: 721, com_id: 0 },
    ])
})

test("a fourth real guest cannot expand an already full real-player lobby", async t => {
    startCapturedLobbyLifecycle()
    const { room, host, guests } = createLobbyRoom(t, 522, [622, 722])
    const getRecruitCalls = stubRecruitment(t, [
        { viewer_id: 987000001, com_id: 1 },
        { viewer_id: 987000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()
    assert.deepEqual(host.client.mates.map(mate => mate.viewerId), [522, 622, 722])

    const fourthGuest = createLobbyClient(room, 822, "guest-822")
    guests.push(fourthGuest)
    handleMessage(fourthGuest.socket, [0, [0, { party: { source: "fourth-guest" } }]])

    assert.equal(getRecruitCalls(), 0)
    assert.equal(room.npc_count, 0)
    assert.deepEqual(host.client.mates.map(mate => mate.viewerId), [522, 622, 722])
    assert.equal(host.client.mates.filter(mate => mate.comId).length, 0)
    assert.deepEqual(room.mates, [
        { viewer_id: 522, com_id: 0 },
        { viewer_id: 622, com_id: 0 },
        { viewer_id: 722, com_id: 0 },
    ])
})

test("a pending newer EnterComs request does not invalidate committed NPC timers", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 523)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "已提交甲" },
        { com_id: 2, name: "已提交乙" },
    ]
    const pendingRecruitment = deferred()
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    let recruitCalls = 0
    NpcMateProvider.prototype.onRecruit = () => {
        recruitCalls++
        if (recruitCalls === 1) {
            return Promise.resolve({
                recruitedMates: [
                    { viewer_id: 988000001, com_id: 1 },
                    { viewer_id: 988000002, com_id: 2 },
                ],
            })
        }
        return pendingRecruitment.promise
    }
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()
    assert.equal(timers.length, 2)

    handleMessage(host.socket, [0, [10, []]])
    assert.equal(recruitCalls, 2)

    const originalSendJson = sessionManager.sendJson
    const originalBroadcast = sessionManager.broadcastToRoom
    let joinMessages = 0
    const npcReadyIds = []
    sessionManager.sendJson = (_socket, data) => {
        if (data?.[1]?.[0] === 1) joinMessages++
    }
    sessionManager.broadcastToRoom = (_roomNumber, data) => {
        if (data?.[1]?.[0] === 2 && String(data[1][1]).includes("-npc-")) {
            npcReadyIds.push(data[1][1])
        }
    }
    try {
        for (const timer of timers) timer.callback()
    } finally {
        sessionManager.sendJson = originalSendJson
        sessionManager.broadcastToRoom = originalBroadcast
    }

    assert.equal(joinMessages, 1)
    assert.deepEqual(npcReadyIds, [
        `${room.room_number}-npc-1`,
        `${room.room_number}-npc-2`,
    ])
})

test("a late older recruitment cannot overwrite a newer committed response", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 524)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "乱序甲" },
        { com_id: 2, name: "乱序乙" },
    ]
    const recruitments = [deferred(), deferred()]
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    let recruitIndex = 0
    NpcMateProvider.prototype.onRecruit = () => recruitments[recruitIndex++].promise
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })

    handleMessage(host.socket, [0, [10, []]])
    handleMessage(host.socket, [0, [10, []]])
    recruitments[1].resolve({
        recruitedMates: [
            { viewer_id: 990000001, com_id: 1 },
            { viewer_id: 990000002, com_id: 2 },
        ],
    })
    await flushPromises()
    recruitments[0].resolve({
        recruitedMates: [
            { viewer_id: 989000001, com_id: 1 },
            { viewer_id: 989000002, com_id: 2 },
        ],
    })
    await flushPromises()

    assert.deepEqual(
        host.client.mates.filter(mate => mate.comId).map(mate => mate.viewerId),
        [990000001, 990000002],
    )
    assert.equal(timers.length, 2)
})

test("a stale Ready timer skips an NPC removed by a newly entered guest", async t => {
    const timers = startCapturedLobbyLifecycle()
    const { room, host, guests } = createLobbyRoom(t, 518)
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "即将替换" },
        { com_id: 2, name: "继续在房" },
    ]
    stubRecruitment(t, [
        { viewer_id: 983000001, com_id: 1 },
        { viewer_id: 983000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()
    assert.equal(timers.length, 2)

    const guest = createLobbyClient(room, 618, "guest-618")
    guests.push(guest)
    handleMessage(guest.socket, [0, [0, { party: { source: "guest" } }]])
    assert.deepEqual(host.client.mates.filter(mate => mate.comId).map(mate => mate.comId), [2])

    const originalBroadcast = sessionManager.broadcastToRoom
    const npcReadyIds = []
    sessionManager.broadcastToRoom = (_roomNumber, data) => {
        if (data?.[1]?.[0] === 2 && String(data[1][1]).includes("-npc-")) {
            npcReadyIds.push(data[1][1])
        }
    }
    try {
        const readyTimer = timers.find(timer => timer.delayMs === 2500)
        assert.ok(readyTimer)
        readyTimer.callback()
    } finally {
        sessionManager.broadcastToRoom = originalBroadcast
    }

    assert.deepEqual(npcReadyIds, [`${room.room_number}-npc-2`])
})

test("active com_id 2 selects the second configured NPC party", async t => {
    startCapturedLobbyLifecycle()
    const { room, host } = createLobbyRoom(t, 519, [619])
    room.npc_count = 2
    room.npc_roster = [
        { com_id: 1, name: "队伍甲" },
        { com_id: 2, name: "队伍乙" },
    ]
    host.client.npcPartySnapshots = [
        { marker: "npc-party-0" },
        { marker: "npc-party-1" },
    ]
    stubRecruitment(t, [
        { viewer_id: 984000001, com_id: 1 },
        { viewer_id: 984000002, com_id: 2 },
    ])

    handleMessage(host.socket, [0, [10, []]])
    await flushPromises()

    const npc = host.client.mates.find(mate => mate.comId === 2)
    assert.ok(npc)
    assert.deepEqual(npc.party, { marker: "npc-party-1" })
})
