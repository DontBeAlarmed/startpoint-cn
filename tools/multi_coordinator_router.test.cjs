"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const BetterSqlite3 = require("better-sqlite3")
const {
    ensureActiveQuestCoordinatorOriginStorageSync,
} = require("../src/lib/quest/active-quest-persistence")
const { RoutedMultiCoordinator } = require("../src/multi/coordinator/router")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { MultiSettlementVerifier } = require("../src/multi/settlement/verifier")

const participant = Object.freeze({ nodeSessionId: "node-a", viewerId: 101 })
const compatibility = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "1.8.1",
    RES_VER: "1.4.54",
    cdnTargetVersion: "cn-test",
    contentDigest: `sha256:${"1".repeat(64)}`,
    modeDigest: `sha256:${"2".repeat(64)}`,
})
const battleSessionId = "123e4567-e89b-42d3-a456-426614174001"

function room(roomNumber) {
    return {
        roomNumber,
        accessToken: `token-${roomNumber}`,
        category: 1,
        questId: 1001,
        hostEntryTime: 1,
        roomSequence: 1,
        raisingState: 1,
        shareRoomOptions: 0,
        hostMainCharacterId: 101,
        isNpcMode: false,
        hostOnline: true,
        host: participant,
        members: [participant],
        compatibility,
    }
}

function battle(roomNumber) {
    return {
        battleSessionId,
        roomNumber,
        host: participant,
        participants: [participant],
        finalized: false,
    }
}

function coordinator(label, overrides = {}) {
    const calls = []
    const invoke = (name, fallback) => async input => {
        calls.push({ label, name, input: structuredClone(input) })
        const behavior = overrides[name]
        return typeof behavior === "function" ? behavior(input) : behavior ?? fallback(input)
    }
    return {
        calls,
        createRoom: invoke("createRoom", () => ({ ok: true, value: room(label === "remote" ? "111111" : "222222") })),
        searchRoom: invoke("searchRoom", input => ({ ok: true, value: room(input.roomNumber ?? "111111") })),
        prepareRoom: invoke("prepareRoom", input => ({ ok: true, value: room(input.roomNumber ?? "111111") })),
        selectRoom: invoke("selectRoom", input => ({ ok: true, value: room(input.roomNumber ?? "111111") })),
        disbandRoom: invoke("disbandRoom", () => ({ ok: true, value: undefined })),
        abortBattle: invoke("abortBattle", () => ({ ok: true, value: undefined })),
        startBattle: invoke("startBattle", input => ({ ok: true, value: battle(input.roomNumber) })),
        finalizeBattle: invoke("finalizeBattle", input => ({ ok: true, value: { ...battle(input.roomNumber), finalized: true } })),
        getBattleStatus: invoke("getBattleStatus", input => ({ ok: true, value: battle(input.roomNumber) })),
        getRoomStatus: invoke("getRoomStatus", input => ({ ok: true, value: room(input.roomNumber) })),
        issue: invoke("issue", input => ({ ok: true, value: input })),
    }
}

function createInput() {
    return {
        requestId: "create-1",
        participant,
        localPlayerId: 1,
        partyId: 1,
        category: 1,
        questId: 1001,
        leaderCharacterId: 101,
        compatibility,
    }
}

function compatibleInput(roomNumber = "123456") {
    return { participant, roomNumber, compatibility }
}

function routed(options = {}) {
    const remote = options.remote ?? coordinator("remote")
    const local = options.local ?? coordinator("local")
    let newRoomOrigin = options.newRoomOrigin ?? "remote"
    const activeOrigins = options.activeOrigins ?? new Map()
    const router = new RoutedMultiCoordinator({
        remote,
        local,
        remoteAdmissionIssuer: remote,
        localAdmissionIssuer: local,
        newRoomOrigin: () => newRoomOrigin,
        resolveActiveQuestOrigin: input => activeOrigins.get(input.viewerId) ?? null,
    })
    return {
        router,
        remote,
        local,
        setNewRoomOrigin(origin) { newRoomOrigin = origin },
    }
}

test("active quest origin migration accepts null, remote and local", () => {
    const database = new BetterSqlite3(":memory:")
    test.after(() => database.close())
    database.exec(`
        CREATE TABLE players_active_quests (
            player_id INTEGER PRIMARY KEY,
            play_id TEXT NOT NULL
        );
        INSERT INTO players_active_quests (player_id, play_id) VALUES (1, 'legacy');
    `)

    ensureActiveQuestCoordinatorOriginStorageSync(database)

    assert.equal(database.prepare(
        "SELECT coordinator_origin AS origin FROM players_active_quests WHERE player_id = 1",
    ).get().origin, null)
    for (const origin of ["remote", "local", null]) {
        database.prepare(
            "UPDATE players_active_quests SET coordinator_origin = ? WHERE player_id = 1",
        ).run(origin)
        assert.equal(database.prepare(
            "SELECT coordinator_origin AS origin FROM players_active_quests WHERE player_id = 1",
        ).get().origin, origin)
    }
    assert.throws(() => database.prepare(
        "UPDATE players_active_quests SET coordinator_origin = 'invalid' WHERE player_id = 1",
    ).run(), /CHECK constraint failed/)
})

test("active quest domain persists remote and local while forcing single quests to null", async t => {
    const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-origin-storage-"))
    const previousDataDirectory = process.env.DATA_DIR
    const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
    process.env.DATA_DIR = databaseRoot
    delete process.env.WDFP_DATABASE_DIR

    const { closeDatabase, initializeDatabase } = require("../src/data")
    const { insertAccountSync } = require("../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../src/data/domains/player")
    const {
        getPlayerActiveQuestSync,
        insertPlayerActiveQuestSync,
    } = require("../src/data/domains/quest_active")
    const { getDb } = require("../src/data/db")
    t.after(() => {
        closeDatabase()
        fs.rmSync(databaseRoot, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    })

    initializeDatabase()
    function makePlayer(label) {
        const account = insertAccountSync({
            appId: "wf_cn", idpAlias: "", idpCode: "test", idpId: label, status: "normal",
        })
        return insertDefaultPlayerSync(account.id).id
    }
    function quest(playerId, isMulti, coordinatorOrigin) {
        return {
            playerId,
            playId: `play-${playerId}`,
            questId: 1001,
            category: 1,
            useBossBoostPoint: false,
            useBoostPoint: false,
            isAutoStartMode: false,
            isMulti,
            coordinatorOrigin,
            roomNumber: isMulti ? "123456" : null,
            battleSessionId: isMulti ? battleSessionId : null,
            entryItemId: null,
            entryItemCount: null,
            eventId: null,
            continueCount: 0,
        }
    }

    const remotePlayer = makePlayer("remote")
    const localPlayer = makePlayer("local")
    const singlePlayer = makePlayer("single")
    insertPlayerActiveQuestSync(remotePlayer, quest(remotePlayer, true, "remote"))
    insertPlayerActiveQuestSync(localPlayer, quest(localPlayer, true, "local"))
    insertPlayerActiveQuestSync(singlePlayer, quest(singlePlayer, false, "remote"))

    assert.equal(getPlayerActiveQuestSync(remotePlayer).coordinatorOrigin, "remote")
    assert.equal(getPlayerActiveQuestSync(localPlayer).coordinatorOrigin, "local")
    assert.equal(getPlayerActiveQuestSync(singlePlayer).coordinatorOrigin, null)
    assert.equal(getDb().prepare(
        "SELECT coordinator_origin AS origin FROM players_active_quests WHERE player_id = ?",
    ).get(singlePlayer).origin, null)
    assert.throws(
        () => insertPlayerActiveQuestSync(makePlayer("missing"), quest(999999, true, null)),
        /coordinator origin/i,
    )
})

test("create uses the current new-room origin and records the room origin", async () => {
    const fixture = routed({ newRoomOrigin: "local" })

    const result = await fixture.router.createRoom(createInput())

    assert.equal(result.ok, true)
    assert.deepEqual(fixture.remote.calls, [])
    assert.equal(fixture.local.calls[0].name, "createRoom")
    assert.equal(await fixture.router.resolveOrigin({ participant, roomNumber: result.value.roomNumber }), "local")
})

test("create ignores a prior selected room after the new-room origin changes", async () => {
    const remote = coordinator("remote", {
        selectRoom: { ok: false, error: "ROOM_NOT_FOUND" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local, newRoomOrigin: "remote" })

    assert.equal((await fixture.router.selectRoom(compatibleInput())).ok, true)
    fixture.setNewRoomOrigin("remote")
    const created = await fixture.router.createRoom(createInput())

    assert.equal(created.ok, true)
    assert.deepEqual(remote.calls.map(call => call.name), ["selectRoom", "createRoom"])
    assert.deepEqual(local.calls.map(call => call.name), ["selectRoom"])
})

test("search retries the other origin only after an explicit ROOM_NOT_FOUND", async () => {
    const remote = coordinator("remote", {
        searchRoom: { ok: false, error: "ROOM_NOT_FOUND" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local })

    const result = await fixture.router.searchRoom(compatibleInput())

    assert.equal(result.ok, true)
    assert.deepEqual(
        [...remote.calls, ...local.calls].map(call => `${call.label}:${call.name}`),
        ["remote:searchRoom", "local:searchRoom"],
    )
})

test("HUB_UNAVAILABLE is preserved and never falls back to local", async () => {
    const remote = coordinator("remote", {
        selectRoom: { ok: false, error: "HUB_UNAVAILABLE" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local })

    const result = await fixture.router.selectRoom(compatibleInput())

    assert.deepEqual(result, { ok: false, error: "HUB_UNAVAILABLE" })
    assert.equal(remote.calls.length, 1)
    assert.equal(local.calls.length, 0)
})

test("successful selection fixes prepare, admission and start to the selected origin", async () => {
    const remote = coordinator("remote", {
        selectRoom: { ok: false, error: "ROOM_NOT_FOUND" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local })
    const input = compatibleInput("123456")

    assert.equal((await fixture.router.selectRoom(input)).ok, true)
    fixture.setNewRoomOrigin("remote")
    assert.equal((await fixture.router.prepareRoom(input)).ok, true)
    assert.equal((await fixture.router.issue({
        roomNumber: "123456",
        participant,
        snapshot: { viewerId: participant.viewerId },
        expiresAt: Date.now() + 1000,
    })).ok, true)
    assert.equal((await fixture.router.startBattle({
        participant,
        roomNumber: "123456",
        compatibility,
    })).ok, true)

    assert.deepEqual(
        local.calls.map(call => call.name),
        ["selectRoom", "prepareRoom", "issue", "startBattle"],
    )
    assert.deepEqual(remote.calls.map(call => call.name), ["selectRoom"])
})

test("HTTP context exposes the routed room origin after selection", async () => {
    const remote = coordinator("remote", {
        selectRoom: { ok: false, error: "ROOM_NOT_FOUND" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local })
    const context = createEmbeddedMultiHttpContext({ coordinator: fixture.router })

    const selected = await context.coordinator.selectRoom(compatibleInput())

    assert.equal(selected.ok, true)
    assert.equal(await context.resolveCoordinatorOrigin({
        participant,
        roomNumber: selected.value.roomNumber,
    }), "local")
})

test("settlement verifier queries only the active quest coordinator origin", async () => {
    const remote = coordinator("remote", {
        getBattleStatus: { ok: false, error: "HUB_UNAVAILABLE" },
    })
    const local = coordinator("local")
    const fixture = routed({ remote, local, newRoomOrigin: "remote" })
    const verifier = new MultiSettlementVerifier(fixture.router)

    const result = await verifier.inspect({
        ...participant,
        roomNumber: "123456",
        battleSessionId,
        coordinatorOrigin: "local",
    })

    assert.deepEqual(result, { state: "active" })
    assert.equal(remote.calls.length, 0)
    assert.deepEqual(local.calls.map(call => call.name), ["getBattleStatus"])
})

test("an explicit active quest origin pins every recovery and write operation", async () => {
    const activeOrigins = new Map([[participant.viewerId, "remote"]])
    const fixture = routed({ activeOrigins, newRoomOrigin: "local" })
    const compatible = compatibleInput()
    const roomInput = { participant, roomNumber: "123456" }
    const battleInput = { ...roomInput, battleSessionId }

    await fixture.router.searchRoom(compatible)
    await fixture.router.selectRoom(compatible)
    await fixture.router.prepareRoom(compatible)
    await fixture.router.getRoomStatus(roomInput)
    await fixture.router.startBattle({ ...roomInput, compatibility })
    await fixture.router.getBattleStatus(battleInput)
    await fixture.router.finalizeBattle(battleInput)
    await fixture.router.abortBattle(roomInput)
    await fixture.router.disbandRoom(roomInput)
    await fixture.router.issue({
        roomNumber: "123456",
        participant,
        snapshot: { viewerId: participant.viewerId },
        expiresAt: Date.now() + 1000,
    })

    assert.equal(fixture.remote.calls.length, 10)
    assert.equal(fixture.local.calls.length, 0)
})

test("remote write failures are never replayed against local", async () => {
    const writeMethods = [
        ["createRoom", createInput()],
        ["prepareRoom", compatibleInput()],
        ["disbandRoom", { participant, roomNumber: "123456" }],
        ["abortBattle", { participant, roomNumber: "123456" }],
        ["startBattle", { participant, roomNumber: "123456", compatibility }],
        ["finalizeBattle", { participant, roomNumber: "123456", battleSessionId }],
    ]
    for (const [method, input] of writeMethods) {
        const remote = coordinator("remote", {
            [method]: { ok: false, error: "HUB_UNAVAILABLE" },
        })
        const local = coordinator("local")
        const fixture = routed({ remote, local })

        assert.deepEqual(await fixture.router[method](input), {
            ok: false,
            error: "HUB_UNAVAILABLE",
        }, method)
        assert.equal(local.calls.length, 0, method)
    }
})

test("successful disband clears the room origin before a reused room is selected", async () => {
    const remote = coordinator("remote")
    const local = coordinator("local")
    const fixture = routed({ remote, local, newRoomOrigin: "remote" })
    const roomNumber = "123456"

    assert.equal((await fixture.router.selectRoom(compatibleInput(roomNumber))).ok, true)
    assert.deepEqual(await fixture.router.disbandRoom({ participant, roomNumber }), {
        ok: true,
        value: undefined,
    })

    fixture.setNewRoomOrigin("local")
    const selected = await fixture.router.selectRoom(compatibleInput(roomNumber))

    assert.equal(selected.ok, true)
    assert.deepEqual(remote.calls.map(call => call.name), ["selectRoom", "disbandRoom"])
    assert.deepEqual(local.calls.map(call => call.name), ["selectRoom"])
})

test("successful abort, finalize and disband clear their room origins", async () => {
    const operations = ["abortBattle", "finalizeBattle", "disbandRoom"]

    for (const operation of operations) {
        const remote = coordinator("remote")
        const local = coordinator("local")
        const fixture = routed({ remote, local, newRoomOrigin: "remote" })
        const roomNumber = "123456"

        assert.equal((await fixture.router.selectRoom(compatibleInput(roomNumber))).ok, true, operation)
        const input = operation === "finalizeBattle"
            ? { participant, roomNumber, battleSessionId }
            : { participant, roomNumber }
        assert.equal((await fixture.router[operation](input)).ok, true, operation)

        fixture.setNewRoomOrigin("local")
        assert.equal((await fixture.router.selectRoom(compatibleInput(roomNumber))).ok, true, operation)
        assert.deepEqual(local.calls.map(call => call.name), ["selectRoom"], operation)
    }
})

test("failed abort, finalize and disband keep their room origins", async () => {
    for (const error of ["ROOM_NOT_FOUND", "HUB_UNAVAILABLE"]) {
        for (const operation of ["abortBattle", "finalizeBattle", "disbandRoom"]) {
            const remote = coordinator("remote", { [operation]: { ok: false, error } })
            const local = coordinator("local")
            const fixture = routed({ remote, local, newRoomOrigin: "remote" })
            const roomNumber = "123456"

            assert.equal((await fixture.router.selectRoom(compatibleInput(roomNumber))).ok, true, `${error}:${operation}`)
            const input = operation === "finalizeBattle"
                ? { participant, roomNumber, battleSessionId }
                : { participant, roomNumber }
            assert.deepEqual(await fixture.router[operation](input), { ok: false, error }, `${error}:${operation}`)

            fixture.setNewRoomOrigin("local")
            assert.equal((await fixture.router.selectRoom(compatibleInput(roomNumber))).ok, true, `${error}:${operation}`)
            assert.deepEqual(remote.calls.map(call => call.name), ["selectRoom", operation, "selectRoom"], `${error}:${operation}`)
            assert.deepEqual(local.calls.map(call => call.name), [], `${error}:${operation}`)
        }
    }
})
