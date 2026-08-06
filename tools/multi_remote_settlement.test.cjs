"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

let settlement = {}
let facts = {}
try {
    settlement = require("../src/multi/settlement/verifier")
    facts = require("../src/multi/settlement/facts")
} catch {
    // RED: persistent Hub battle facts and settlement verification are introduced here.
}

const { MultiSettlementVerifier } = settlement
const { BattleFactStore } = facts
const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { RemoteMultiCoordinator } = require("../src/multi/coordinator/remote")
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")
const { HubClient } = require("../src/multi/hub/client")
const { IdempotencyCache } = require("../src/multi/hub/idempotency")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")
const { buildMultiHubControlApp } = require("../src/multi/hub/server")
const { disbandRoom, getRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")

const host = Object.freeze({ nodeSessionId: "node-host", viewerId: 101 })
const guest = Object.freeze({ nodeSessionId: "node-guest", viewerId: 202 })

function status(overrides = {}) {
    return Object.freeze({
        battleSessionId: "battle-1",
        roomNumber: "123456",
        host,
        participants: [host, guest],
        finalized: true,
        ...overrides,
    })
}

test("settlement verifier queries all persistent identity fields and derives host role", async () => {
    assert.equal(typeof MultiSettlementVerifier, "function")
    const calls = []
    const verifier = new MultiSettlementVerifier({
        getBattleStatus: async input => {
            calls.push(input)
            return { ok: true, value: status() }
        },
    })

    assert.deepEqual(await verifier.verify({
        nodeSessionId: guest.nodeSessionId,
        viewerId: guest.viewerId,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }), { ok: true, isHost: false })
    assert.deepEqual(calls, [{
        participant: guest,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }])
})

test("settlement verifier accepts a Hub-authorized rotated node session", async () => {
    const rotatedHost = { nodeSessionId: "node-host-rotated", viewerId: host.viewerId }
    const verifier = new MultiSettlementVerifier({
        getBattleStatus: async () => ({
            ok: true,
            value: status({ host: rotatedHost, participants: [rotatedHost, guest] }),
        }),
    })

    assert.deepEqual(await verifier.verify({
        nodeSessionId: host.nodeSessionId,
        viewerId: host.viewerId,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }), { ok: true, isHost: true })
})

test("settlement verifier fails closed for unavailable or forged Hub facts", async () => {
    assert.equal(typeof MultiSettlementVerifier, "function")
    for (const coordinatorResult of [
        { ok: false, error: "HUB_UNAVAILABLE" },
        { ok: true, value: status({ finalized: false }) },
        { ok: true, value: status({ participants: [host] }) },
        { ok: true, value: status({ roomNumber: "wrong-room" }) },
        { ok: true, value: status({ battleSessionId: "wrong-battle" }) },
    ]) {
        const verifier = new MultiSettlementVerifier({
            getBattleStatus: async () => coordinatorResult,
        })
        assert.deepEqual(await verifier.verify({
            nodeSessionId: guest.nodeSessionId,
            viewerId: guest.viewerId,
            roomNumber: "123456",
            battleSessionId: "battle-1",
        }), { ok: false })
    }
})

test("Hub battle facts survive room release but expire within thirty minutes", () => {
    assert.equal(typeof BattleFactStore, "function")
    let now = 1_000
    let sequence = 0
    const store = new BattleFactStore({
        now: () => now,
        createBattleSessionId: () => `battle-${++sequence}`,
    })
    const started = store.startBattle({
        roomNumber: "123456",
        host,
        participants: [host, guest],
    })
    assert.equal(started.battleSessionId, "battle-1")
    assert.equal(store.startBattle({
        roomNumber: "123456",
        host,
        participants: [host, guest],
    }).battleSessionId, "battle-1", "repeated starts share one persistent identity")

    assert.equal(store.markFinalized({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }).ok, true)
    assert.throws(() => store.startBattle({
        roomNumber: "123456",
        host,
        participants: [host, guest],
    }), /finalized/i)
    store.releaseRoom("123456")
    assert.deepEqual(store.getBattleStatus({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }), { ok: true, value: status({ battleSessionId: "battle-1" }) })

    now += 30 * 60 * 1000
    assert.deepEqual(store.getBattleStatus({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: "battle-1",
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})

test("Hub battle fact retention keeps the first finalize deadline after participant removal", () => {
    let now = 1_000
    const store = new BattleFactStore({
        now: () => now,
        retentionMs: 100,
        createBattleSessionId: () => "fixed-deadline-battle",
    })
    const started = store.startBattle({
        roomNumber: "123456",
        host,
        participants: [host, guest],
    })
    assert.equal(store.markFinalized({
        participant: host,
        roomNumber: "123456",
        battleSessionId: started.battleSessionId,
    }).ok, true)

    now += 50
    assert.equal(store.removeParticipant({
        participant: host,
        roomNumber: "123456",
    }).ok, true)
    assert.equal(store.markFinalized({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: started.battleSessionId,
    }).ok, true)
    store.releaseRoom("123456")

    now = 1_099
    assert.equal(store.getBattleStatus({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: started.battleSessionId,
    }).ok, true)
    now = 1_100
    assert.deepEqual(store.getBattleStatus({
        participant: guest,
        roomNumber: "123456",
        battleSessionId: started.battleSessionId,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})

test("Hub battle facts discard unfinished records when their room is released", () => {
    const store = new BattleFactStore({ createBattleSessionId: () => "abandoned-battle" })
    store.startBattle({ roomNumber: "123456", host, participants: [host, guest] })
    store.releaseRoom("123456")

    assert.deepEqual(store.getBattleStatus({
        participant: host,
        roomNumber: "123456",
        battleSessionId: "abandoned-battle",
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})

test("Hub battle facts reject forged participants and bound retained records", () => {
    assert.equal(typeof BattleFactStore, "function")
    let sequence = 0
    const store = new BattleFactStore({
        maxRecords: 2,
        createBattleSessionId: () => `battle-${++sequence}`,
    })
    for (const roomNumber of ["100001", "100002", "100003"]) {
        const battle = store.startBattle({ roomNumber, host, participants: [host, guest] })
        store.markFinalized({
            participant: host,
            roomNumber,
            battleSessionId: battle.battleSessionId,
        })
        store.releaseRoom(roomNumber)
    }
    assert.deepEqual(store.getBattleStatus({
        participant: host,
        roomNumber: "100001",
        battleSessionId: "battle-1",
    }), { ok: false, error: "ROOM_NOT_FOUND" })
    assert.deepEqual(store.getBattleStatus({
        participant: { nodeSessionId: "forged-node", viewerId: guest.viewerId },
        roomNumber: "100003",
        battleSessionId: "battle-3",
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })
})

test("Hub battle facts preserve live records when capacity is exhausted", () => {
    let now = 1_000
    let sequence = 0
    const store = new BattleFactStore({
        now: () => now,
        retentionMs: 10,
        maxRecords: 2,
        createBattleSessionId: () => `battle-${++sequence}`,
    })
    const active = store.startBattle({
        roomNumber: "100001",
        host,
        participants: [host, guest],
    })
    const finalized = store.startBattle({
        roomNumber: "100002",
        host,
        participants: [host, guest],
    })
    assert.equal(store.markFinalized({
        participant: host,
        roomNumber: "100002",
        battleSessionId: finalized.battleSessionId,
    }).ok, true)
    now += 10

    assert.equal(store.startBattle({
        roomNumber: "100001",
        host,
        participants: [host, guest],
    }).battleSessionId, active.battleSessionId, "repeated starts do not consume capacity")
    assert.throws(() => store.startBattle({
        roomNumber: "100003",
        host,
        participants: [host, guest],
    }), /capacity/i)
    assert.equal(sequence, 2, "capacity failure does not consume a battle session id")
    assert.equal(store.getActiveBattleSessionId("100001"), active.battleSessionId)
    assert.equal(store.getActiveBattleSessionId("100002"), finalized.battleSessionId)
    assert.equal(store.getBattleStatus({
        participant: host,
        roomNumber: "100001",
        battleSessionId: active.battleSessionId,
    }).ok, true)
    assert.equal(store.getBattleStatus({
        participant: host,
        roomNumber: "100002",
        battleSessionId: finalized.battleSessionId,
    }).ok, true)

    store.releaseRoom("100002")
    const replacement = store.startBattle({
        roomNumber: "100003",
        host,
        participants: [host, guest],
    })
    assert.equal(replacement.battleSessionId, "battle-3")
    assert.equal(store.getActiveBattleSessionId("100001"), active.battleSessionId)
    assert.deepEqual(store.getBattleStatus({
        participant: host,
        roomNumber: "100002",
        battleSessionId: finalized.battleSessionId,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})

test("rotated guest session takes ownership before the old session is swept", () => {
    const oldGuest = { nodeSessionId: "guest-session-old", viewerId: guest.viewerId }
    const rotatedGuest = { nodeSessionId: "guest-session-new", viewerId: guest.viewerId }
    const store = new BattleFactStore({ createBattleSessionId: () => "rotation-battle" })
    const started = store.startBattle({
        roomNumber: "rotation-room",
        host,
        participants: [host, oldGuest],
    })
    const oldInput = {
        participant: oldGuest,
        credentialId: "guest-credential",
        roomNumber: "rotation-room",
        battleSessionId: started.battleSessionId,
    }
    assert.equal(store.authorizeParticipant(oldInput).ok, true)
    assert.equal(store.markFinalized(oldInput).ok, true)

    const rotatedInput = { ...oldInput, participant: rotatedGuest }
    assert.equal(store.getBattleStatus(rotatedInput).ok, true)
    assert.equal(
        store.removeParticipantsByNodeSession("rotation-room", oldGuest.nodeSessionId),
        null,
        "the expired session no longer owns the finalized guest",
    )
    const retained = store.getBattleStatus(rotatedInput)
    assert.equal(retained.ok, true)
    assert.deepEqual(retained.value.participants, [host, rotatedGuest])
    assert.equal(retained.value.finalized, true)
})

test("Hub coordinator exposes retained TCP completion facts without finalizing them", async t => {
    const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
    const { addRoomMember, disbandRoom } = require("../src/multi/room/manager")
    const { sessionManager } = require("../src/multi/state/SessionManager")
    const compatibility = Object.freeze({
        multiProtocolVersion: 1,
        APP_VER: "1.8.1",
        RES_VER: "1",
        cdnTargetVersion: "cn",
        contentDigest: `sha256:${"a".repeat(64)}`,
        modeDigest: `sha256:${"b".repeat(64)}`,
    })
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const created = await coordinator.createRoom({
        requestId: "remote-settlement-room",
        participant: host,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const roomNumber = created.value.roomNumber
    addRoomMember(roomNumber, guest.viewerId)
    const guestClient = sessionManager.createClient({
        writable: false,
        end() {},
    }, guest.viewerId, roomNumber, "guest-lobby-cid")
    guestClient.participant = guest
    assert.equal(sessionManager.addClientToRoom(guestClient).ok, true)
    t.after(() => {
        sessionManager.removeClient(guestClient)
        disbandRoom(roomNumber)
    })
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: "host-cid", participant: host },
        { connectionId: "guest-cid", participant: guest },
    ], host)

    const started = await coordinator.startBattle({ participant: guest, roomNumber, compatibility })
    assert.equal(started.ok, true)
    assert.equal(started.value.finalized, false)
    assert.deepEqual(await coordinator.finalizeBattle({
        participant: guest,
        roomNumber,
        battleSessionId: started.value.battleSessionId,
    }), started, "HTTP finalize operation must not manufacture a TCP completion fact")

    sessionManager.markParticipantFinalizedBattle(roomNumber, guest)
    sessionManager.clearBattleSceneState(roomNumber)
    const delayed = await coordinator.getBattleStatus({
        participant: guest,
        roomNumber,
        battleSessionId: started.value.battleSessionId,
    })
    assert.equal(delayed.ok, true)
    assert.equal(delayed.value.finalized, true)
    assert.deepEqual(await coordinator.getBattleStatus({
        participant: { nodeSessionId: "forged-node", viewerId: guest.viewerId },
        roomNumber,
        battleSessionId: started.value.battleSessionId,
    }), { ok: false, error: "ROOM_PERMISSION_DENIED" })
})

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-remote-settlement-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["mission_active.json", "mission_active_event.json"],
})
const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { activeQuests } = require("../src/lib/quest/active-quest-service")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const { registerBattleRoutes } = require("../src/multi/http/battle")
const cnLoadRoutes = require("../src/routes/cn/load").default

process.once("exit", () => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

const productionQuest = Object.freeze({ category: 13, questId: 2001, ticketId: 500000 })
const roomNumber = "123456"
const battleSessionId = "123e4567-e89b-42d3-a456-426614174002"

function startPayload(viewerId, playId, overrides = {}) {
    return {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: productionQuest.questId,
        category: productionQuest.category,
        party_id: 1,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
        room_number: roomNumber,
        mate_player_ids: [],
        play_id: playId,
        ...overrides,
    }
}

function finishPayload(viewerId, playId, overrides = {}) {
    return {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: productionQuest.questId,
        category: productionQuest.category,
        room_number: roomNumber,
        play_id: playId,
        score: 0,
        elapsed_time_ms: 1_000,
        add_mana: 0,
        is_accomplished: true,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{ use_power_flip_count: 1 }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
        mate_player_result: [],
        ...overrides,
    }
}

const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

function fetchThroughHub(app) {
    return async (url, init) => {
        const response = await app.inject({
            method: init.method,
            url: new URL(url).pathname,
            headers: init.headers,
            payload: init.body,
        })
        return new Response(response.body, {
            status: response.statusCode,
            headers: response.headers,
        })
    }
}

function createRotatingHub(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-settlement-rotation-hub-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "credentials.json")
    const credentialStore = new MultiHubCredentialStore({ credentialsPath })
    const credential = credentialStore.create("rotation-node")
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: () => {},
    })
    assert.equal(reloader.reloadIfChanged(), true)
    let now = 10_000
    let generatedIndex = 0
    const generated = [
        "rotation-session-old", "a".repeat(43),
        "rotation-session-new", "b".repeat(43),
    ]
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const admissions = new AdmissionRegistry({ now: () => now })
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: 1_000,
        generateId: () => generated[generatedIndex++],
        isCredentialEnabled: credentialId => reloader.isCredentialEnabled(credentialId),
        onInvalidated: nodeSessionId => {
            admissions.removeByNodeSession(nodeSessionId)
            coordinator.cleanupNodeSession(nodeSessionId)
        },
    })
    const app = buildMultiHubControlApp({
        coordinator,
        credentialReloader: reloader,
        nodeSessions: sessions,
        admissionIssuer: admissions,
        idempotency: new IdempotencyCache({ now: () => now }),
        tcpEndpoint: { host: "hub.internal", port: 8003 },
    })
    t.after(() => app.close())
    const client = new HubClient({
        hubUrl: new URL("http://hub.example/"),
        token: credential.token,
        fetch: fetchThroughHub(app),
        now: () => now,
    })
    return {
        client,
        coordinator: new RemoteMultiCoordinator(client),
        setNow(value) { now = value },
    }
}

function createSettlementBarrier(expectedCalls = 2) {
    const waiting = []
    let bothWaiting
    const reached = new Promise(resolve => { bothWaiting = resolve })
    return {
        reached,
        verifier: {
            verify: input => new Promise(resolve => {
                waiting.push({ input: structuredClone(input), resolve })
                if (waiting.length === expectedCalls) bothWaiting()
            }),
        },
        release(index, result = { ok: true, isHost: true }) {
            waiting[index].resolve(result)
        },
        calls() {
            return waiting.map(entry => entry.input)
        },
    }
}

async function openProductionHome(label, participant, isHost, settlementVerifier, options = {}) {
    closeDatabase()
    const homeDirectory = path.join(databaseRoot, label)
    process.env.DATA_DIR = homeDirectory
    initializeDatabase()
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({
        id: playerId,
        stamina: 100,
        staminaHealTime: new Date(Math.floor(Date.now() / 1_000) * 1_000),
        totalStaminaUsed: 0,
    })
    givePlayerItemSync(playerId, productionQuest.ticketId, 1)
    const entryStamina = computeRealTimeStamina(getPlayerSync(playerId))

    const effectiveRoomNumber = options.roomNumber ?? roomNumber
    const roomHost = isHost ? participant : host
    const roomMembers = [roomHost, participant].filter((member, index, all) => (
        all.findIndex(candidate => candidate.nodeSessionId === member.nodeSessionId
            && candidate.viewerId === member.viewerId) === index
    ))
    const battle = Object.freeze({
        battleSessionId,
        roomNumber: effectiveRoomNumber,
        host: roomHost,
        participants: roomMembers,
        finalized: false,
    })
    const coordinatorCalls = []
    const coordinator = options.coordinator ?? {
        getRoomStatus: async input => {
            coordinatorCalls.push(structuredClone(input))
            return {
                ok: true,
                value: {
                    roomNumber: effectiveRoomNumber,
                    host: roomHost,
                    members: roomMembers,
                    category: productionQuest.category,
                    questId: productionQuest.questId,
                },
            }
        },
        startBattle: async input => {
            coordinatorCalls.push(structuredClone(input))
            if (options.startBattle) return options.startBattle(input, battle)
            return { ok: true, value: battle }
        },
        finalizeBattle: async input => {
            coordinatorCalls.push(structuredClone(input))
            if (options.finalizeBattle) return options.finalizeBattle(input, battle)
            return { ok: true, value: { ...battle, finalized: true } }
        },
        abortBattle: async input => {
            coordinatorCalls.push(structuredClone(input))
            if (options.abortBattle) return options.abortBattle(input)
            return { ok: true, value: undefined }
        },
    }
    const context = {
        resolvePlayerContext: async viewerId => viewerId === participant.viewerId
            ? { playerId, player: getPlayerSync(playerId) }
            : null,
        snapshotProvider: {
            getParticipant: viewerId => ({ ...participant, viewerId }),
            getCompatibility: () => ({ ok: true, value: compatibility }),
        },
        questAvailability: { check: () => ({ available: true }) },
        coordinator,
        settlementVerifier,
    }
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")
            && payload !== null
            && typeof payload === "object") {
            done(null, JSON.stringify(payload))
            return
        }
        done(null, payload)
    })
    registerBattleRoutes(app, context)
    await app.ready()
    return { app, db, playerId, accountId: account.id, entryStamina, coordinatorCalls }
}

async function closeProductionHome(home) {
    if (home) {
        delete activeQuests[home.playerId]
        await home.app.close()
    }
    closeDatabase()
}

function observableSettlementState(db, playerId) {
    const select = (sql, ...parameters) => db.prepare(sql).all(...parameters)
    return {
        player: select("SELECT * FROM players WHERE id = ?", playerId),
        activeQuest: select("SELECT * FROM players_active_quests WHERE player_id = ?", playerId),
        inventory: select("SELECT * FROM players_items WHERE player_id = ? ORDER BY id", playerId),
        rewardHistory: select("SELECT * FROM players_receive_history WHERE player_id = ? ORDER BY id", playerId),
        questHistory: select("SELECT * FROM players_quest_progress WHERE player_id = ? ORDER BY section, quest_id", playerId),
        missionFacts: select("SELECT * FROM players_mission_battle_counters WHERE player_id = ?", playerId),
        missions: select("SELECT * FROM players_category_missions WHERE player_id = ? ORDER BY category, id", playerId),
        mails: select("SELECT * FROM players_mails WHERE player_id = ? ORDER BY id", playerId),
    }
}

test("production /start rejects a changed compatibility profile before local entry writes", async () => {
    let home
    try {
        home = await openProductionHome(
            "incompatible-start",
            host,
            true,
            { verify: async () => ({ ok: false }) },
            {
                startBattle(input) {
                    assert.deepEqual(input.compatibility, compatibility)
                    return { ok: false, error: "INCOMPATIBLE_ROOM" }
                },
            },
        )
        const response = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, "incompatible-start"),
        })
        assert.equal(response.statusCode, 400)
        assert.equal(getPlayerSync(home.playerId).stamina, home.entryStamina)
        assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
        assert.equal(getPlayerActiveQuestSync(home.playerId), null)
    } finally {
        await closeProductionHome(home)
    }
})

test("production /start charges only the host in isolated SQLite home saves", async () => {
    let home
    try {
        home = await openProductionHome("host-home", host, true, { verify: async () => ({ ok: true, isHost: true }) })
        const hostStart = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, "host-start"),
        })
        assert.equal(hostStart.statusCode, 200, hostStart.body)
        assert.deepEqual({
            stamina: getPlayerSync(home.playerId).stamina,
            totalStaminaUsed: getPlayerSync(home.playerId).totalStaminaUsed,
            ticketCount: getPlayerItemSync(home.playerId, productionQuest.ticketId),
            battleSessionId: getPlayerActiveQuestSync(home.playerId).battleSessionId,
        }, {
            stamina: home.entryStamina - 10,
            totalStaminaUsed: 10,
            ticketCount: 0,
            battleSessionId,
        })
        assert.equal(home.coordinatorCalls.every(call => (
            !Object.hasOwn(call, "database") && !Object.hasOwn(call, "grantRewards")
        )), true)
        await closeProductionHome(home)
        home = null

        home = await openProductionHome("guest-home", guest, false, { verify: async () => ({ ok: true, isHost: false }) })
        const guestStart = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(guest.viewerId, "guest-start"),
        })
        assert.equal(guestStart.statusCode, 200, guestStart.body)
        assert.deepEqual({
            stamina: getPlayerSync(home.playerId).stamina,
            totalStaminaUsed: getPlayerSync(home.playerId).totalStaminaUsed,
            ticketCount: getPlayerItemSync(home.playerId, productionQuest.ticketId),
            battleSessionId: getPlayerActiveQuestSync(home.playerId).battleSessionId,
        }, {
            stamina: 100,
            totalStaminaUsed: 0,
            ticketCount: 1,
            battleSessionId,
        })
    } finally {
        await closeProductionHome(home)
    }
})

test("production /finish settles through a real HubClient session rotation", async t => {
    const hub = createRotatingHub(t)
    const created = await hub.coordinator.createRoom({
        requestId: "production-finish-rotation",
        participant: { nodeSessionId: "pending", viewerId: host.viewerId },
        partyId: 1,
        category: productionQuest.category,
        questId: productionQuest.questId,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const remoteRoomNumber = created.value.roomNumber
    const originalParticipant = created.value.host
    t.after(() => {
        sessionManager.clearBattleExpectedCount(remoteRoomNumber)
        disbandRoom(remoteRoomNumber)
    })
    sessionManager.setBattleParticipants(remoteRoomNumber, [{
        connectionId: "production-finish-rotation-host",
        participant: originalParticipant,
    }], originalParticipant)

    let home
    try {
        home = await openProductionHome(
            "production-finish-rotation",
            originalParticipant,
            true,
            new MultiSettlementVerifier(hub.coordinator),
            { coordinator: hub.coordinator, roomNumber: remoteRoomNumber },
        )
        const playId = "production-finish-rotation"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId, { room_number: remoteRoomNumber }),
        })
        assert.equal(started.statusCode, 200, started.body)
        const storedQuest = getPlayerActiveQuestSync(home.playerId)
        sessionManager.markParticipantFinalizedBattle(remoteRoomNumber, originalParticipant)

        hub.setNow(12_000)
        const finished = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId, { room_number: remoteRoomNumber }),
        })
        assert.equal(finished.statusCode, 200, finished.body)
        assert.notEqual(hub.client.getNodeSessionId(), originalParticipant.nodeSessionId)
        assert.equal(getPlayerActiveQuestSync(home.playerId), null)
        assert.equal(getRoom(remoteRoomNumber).raising_state, 1)
        assert.equal(sessionManager.getActiveBattleSessionId(remoteRoomNumber), null)
        assert.equal(typeof storedQuest.battleSessionId, "string")
    } finally {
        await closeProductionHome(home)
    }
})

for (const [label, participant, isHost] of [
    ["host", host, true],
    ["guest", guest, false],
]) {
    test(`production /start rejects a finalized restart for ${label} without duplicate rewards`, async () => {
        let finalized = false
        let home
        try {
            home = await openProductionHome(
                `finalized-${label}`,
                participant,
                isHost,
                { verify: async () => ({ ok: true, isHost }) },
                {
                    startBattle: (_input, battle) => ({
                        ok: true,
                        value: { ...battle, finalized },
                    }),
                },
            )
            const started = await home.app.inject({
                method: "POST",
                url: "/start",
                payload: startPayload(participant.viewerId, `finalized-${label}-first`),
            })
            assert.equal(started.statusCode, 200, started.body)
            const finished = await home.app.inject({
                method: "POST",
                url: "/finish",
                payload: finishPayload(participant.viewerId, `finalized-${label}-first`),
            })
            assert.equal(finished.statusCode, 200, finished.body)
            finalized = true
            givePlayerItemSync(home.playerId, productionQuest.ticketId, 1)
            const settledOnce = observableSettlementState(home.db, home.playerId)
            assert.equal(settledOnce.questHistory.length, 1)
            assert.ok(settledOnce.inventory.length > 0)

            const restarted = await home.app.inject({
                method: "POST",
                url: "/start",
                payload: startPayload(participant.viewerId, `finalized-${label}-second`),
            })
            assert.equal(restarted.statusCode, 400, restarted.body)
            assert.deepEqual(observableSettlementState(home.db, home.playerId), settledOnce)
        } finally {
            await closeProductionHome(home)
        }
    })
}

test("production /start atomically occupies an empty SQLite active quest", async () => {
    const waiting = []
    let releaseStarts
    const bothAtHub = new Promise(resolve => { releaseStarts = resolve })
    let home
    try {
        home = await openProductionHome(
            "concurrent-start",
            host,
            true,
            { verify: async () => ({ ok: true, isHost: true }) },
            {
                startBattle: (input, battle) => new Promise(resolve => {
                    waiting.push({ input: structuredClone(input), resolve, battle })
                    if (waiting.length === 2) releaseStarts()
                }),
            },
        )
        givePlayerItemSync(home.playerId, productionQuest.ticketId, 1)
        const firstPending = home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, "concurrent-start-a"),
        })
        const secondPending = home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, "concurrent-start-b"),
        })
        await bothAtHub
        for (const pending of waiting) pending.resolve({ ok: true, value: pending.battle })
        const responses = await Promise.all([firstPending, secondPending])
        assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 400])
        assert.equal(getPlayerSync(home.playerId).totalStaminaUsed, 10)
        assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
        assert.ok([
            "concurrent-start-a",
            "concurrent-start-b",
        ].includes(getPlayerActiveQuestSync(home.playerId).playId))
    } finally {
        await closeProductionHome(home)
    }
})

test("production /finish consumes one SQLite settlement after both requests pass the Hub barrier", async () => {
    const barrier = createSettlementBarrier()
    let home
    try {
        home = await openProductionHome("concurrent-finish", host, true, barrier.verifier)
        const playId = "concurrent-finish"
        const started = await home.app.inject({ method: "POST", url: "/start", payload: startPayload(host.viewerId, playId) })
        assert.equal(started.statusCode, 200, started.body)
        const payload = finishPayload(host.viewerId, playId)
        const firstPending = home.app.inject({ method: "POST", url: "/finish", payload })
        const secondPending = home.app.inject({ method: "POST", url: "/finish", payload })

        await barrier.reached
        assert.deepEqual(barrier.calls(), [0, 1].map(() => ({
            nodeSessionId: host.nodeSessionId,
            viewerId: host.viewerId,
            roomNumber,
            battleSessionId,
        })), "两个请求必须都在 SQLite 结算前读到同一 active quest")

        barrier.release(0)
        const first = await firstPending
        assert.equal(first.statusCode, 200, first.body)
        const settledOnce = observableSettlementState(home.db, home.playerId)
        assert.equal(settledOnce.activeQuest.length, 0)
        assert.equal(settledOnce.questHistory.length, 1)
        assert.equal(settledOnce.missionFacts[0].multi_clear_count, 1)
        assert.ok(settledOnce.inventory.length > 0, "真实奖励必须落入库存")

        barrier.release(1)
        const second = await secondPending
        assert.equal(second.statusCode, 400, second.body)
        assert.match(second.body, /active quest|settled|finish/i)
        assert.deepEqual(
            observableSettlementState(home.db, home.playerId),
            settledOnce,
            "重复 finish 不得产生库存、履历、任务、邮件或其他玩家写入",
        )
    } finally {
        await closeProductionHome(home)
    }
})

test("production /finish retries local rollback against the retained Hub fact", async () => {
    const store = new BattleFactStore({ createBattleSessionId: () => battleSessionId })
    store.startBattle({ roomNumber, host, participants: [host] })
    const getBattleStatus = input => Promise.resolve(store.getBattleStatus(input))
    const verifier = new MultiSettlementVerifier({ getBattleStatus })
    let home
    try {
        home = await openProductionHome(
            "retained-fact-retry",
            host,
            true,
            verifier,
            {
                startBattle: input => getBattleStatus({ ...input, battleSessionId }),
                finalizeBattle: getBattleStatus,
            },
        )
        const playId = "retained-fact-retry"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        assert.equal(store.markFinalized({
            participant: host,
            roomNumber,
            battleSessionId,
        }).ok, true)
        store.releaseRoom(roomNumber)
        const beforeFinish = observableSettlementState(home.db, home.playerId)
        home.db.exec(`
            CREATE TRIGGER reject_multi_active_quest_delete
            BEFORE DELETE ON players_active_quests
            WHEN OLD.player_id = ${home.playerId}
            BEGIN SELECT RAISE(ABORT, 'forced multi settlement rollback'); END;
        `)

        const first = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId),
        })
        assert.equal(first.statusCode, 500, first.body)
        assert.deepEqual(
            observableSettlementState(home.db, home.playerId),
            beforeFinish,
            "本地删除失败必须回滚奖励、库存、履历、任务和邮件写入",
        )
        assert.equal((await getBattleStatus({
            participant: host,
            roomNumber,
            battleSessionId,
        })).ok, true, "Hub finalized fact must remain available after local rollback")

        home.db.exec("DROP TRIGGER reject_multi_active_quest_delete")
        const retried = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId),
        })
        assert.equal(retried.statusCode, 200, retried.body)
        assert.equal(getPlayerActiveQuestSync(home.playerId), null)
        assert.equal((await getBattleStatus({
            participant: host,
            roomNumber,
            battleSessionId,
        })).ok, true, "successful local settlement must not consume the retained Hub fact")
    } finally {
        await closeProductionHome(home)
    }
})

test("production /finish uses fresh player balances after the Hub await", async () => {
    const barrier = createSettlementBarrier(1)
    let home
    try {
        home = await openProductionHome("fresh-finish", host, true, barrier.verifier)
        const playId = "fresh-finish"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId, { use_boost_point: true }),
        })
        assert.equal(started.statusCode, 200, started.body)
        const pending = home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId),
        })
        await barrier.reached
        const beforeMutation = getPlayerSync(home.playerId)
        updatePlayerSync({
            id: home.playerId,
            freeMana: beforeMutation.freeMana + 500,
            expPool: beforeMutation.expPool + 700,
            boostPoint: beforeMutation.boostPoint + 2,
        })
        const freshBeforeFinish = getPlayerSync(home.playerId)
        barrier.release(0)
        const finished = await pending
        assert.equal(finished.statusCode, 200, finished.body)
        const after = getPlayerSync(home.playerId)
        assert.equal(after.freeMana, freshBeforeFinish.freeMana + 40)
        assert.equal(after.expPool, freshBeforeFinish.expPool + 180)
        assert.equal(after.boostPoint, freshBeforeFinish.boostPoint - 1)
    } finally {
        await closeProductionHome(home)
    }
})

test("production /load preserves a remote active quest when no local room exists", async () => {
    let home
    let loadApp
    try {
        home = await openProductionHome(
            "remote-load",
            host,
            true,
            { verify: async () => ({ ok: true, isHost: true }) },
        )
        const playId = "remote-load-active"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)
        home.db.prepare(`
            INSERT INTO sessions (token, account_id, expires, type)
            VALUES (?, ?, ?, 2)
        `).run(
            String(host.viewerId),
            home.accountId,
            new Date("2099-12-31T23:59:59.000Z").toISOString(),
        )

        loadApp = Fastify({ logger: false })
        loadApp.addContentTypeParser(
            "application/x-www-form-urlencoded",
            { parseAs: "string" },
            (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
        )
        loadApp.addHook("onSend", (_request, reply, payload, done) => {
            if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
                done(null, pack(payload).toString("base64"))
                return
            }
            done(null, payload)
        })
        await loadApp.register(cnLoadRoutes, {
            assetProvider: { mode: "client-owned" },
            multiMode: "client",
        })
        await loadApp.ready()
        const loaded = await loadApp.inject({
            method: "POST",
            url: "/load",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                res_ver: "1.4.54",
            },
            payload: pack({
                viewer_id: host.viewerId,
                keychain: host.viewerId,
                device_id: 1,
                device_token: "remote-load-device",
            }).toString("base64"),
        })
        assert.equal(loaded.statusCode, 200, loaded.body)
        assert.equal(getPlayerActiveQuestSync(home.playerId).battleSessionId, battleSessionId)
        assert.deepEqual(
            unpack(Buffer.from(loaded.body, "base64")).data.unfinished_multi_quest_list,
            [{ play_id: playId, continue_count: 0 }],
        )
    } finally {
        if (loadApp) await loadApp.close()
        await closeProductionHome(home)
    }
})

test("production /abort uses coordinator authority when no local room exists", async () => {
    let home
    try {
        home = await openProductionHome(
            "remote-abort-route",
            host,
            true,
            { verify: async () => ({ ok: true, isHost: true }) },
        )
        const playId = "remote-abort-route"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)
        const aborted = await home.app.inject({
            method: "POST",
            url: "/abort",
            payload: {
                viewer_id: host.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: playId,
            },
        })
        assert.equal(aborted.statusCode, 200, aborted.body)
        assert.equal(getPlayerActiveQuestSync(home.playerId), null)
        assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
        assert.equal(
            home.coordinatorCalls.some(call => call.roomNumber === roomNumber),
            true,
        )
    } finally {
        await closeProductionHome(home)
    }
})

for (const [label, participant, isHost] of [
    ["host", host, true],
    ["guest", guest, false],
]) {
    test(`production /abort keeps Hub untouched when ${label} SQLite rollback fails`, async () => {
        let home
        try {
            home = await openProductionHome(
                `abort-rollback-${label}`,
                participant,
                isHost,
                { verify: async () => ({ ok: true, isHost }) },
            )
            const playId = `abort-rollback-${label}`
            const started = await home.app.inject({
                method: "POST",
                url: "/start",
                payload: startPayload(participant.viewerId, playId),
            })
            assert.equal(started.statusCode, 200, started.body)
            const callsBeforeAbort = home.coordinatorCalls.length
            home.db.exec(`
                CREATE TRIGGER reject_multi_abort_delete
                BEFORE DELETE ON players_active_quests
                WHEN OLD.player_id = ${home.playerId}
                BEGIN SELECT RAISE(ABORT, 'forced multi abort rollback'); END;
            `)

            const failed = await home.app.inject({
                method: "POST",
                url: "/abort",
                payload: {
                    viewer_id: participant.viewerId,
                    quest_id: productionQuest.questId,
                    category: productionQuest.category,
                    room_number: roomNumber,
                    play_id: playId,
                },
            })
            assert.equal(failed.statusCode, 500, failed.body)
            assert.equal(home.coordinatorCalls.length, callsBeforeAbort)
            assert.notEqual(getPlayerActiveQuestSync(home.playerId), null)
            assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), isHost ? 0 : 1)

            home.db.exec("DROP TRIGGER reject_multi_abort_delete")
            const retried = await home.app.inject({
                method: "POST",
                url: "/abort",
                payload: {
                    viewer_id: participant.viewerId,
                    quest_id: productionQuest.questId,
                    category: productionQuest.category,
                    room_number: roomNumber,
                    play_id: playId,
                },
            })
            assert.equal(retried.statusCode, 200, retried.body)
            assert.equal(home.coordinatorCalls.length, callsBeforeAbort + 1)
            assert.equal(getPlayerActiveQuestSync(home.playerId), null)
            assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
        } finally {
            home?.db.exec("DROP TRIGGER IF EXISTS reject_multi_abort_delete")
            await closeProductionHome(home)
        }
    })

    test(`production /abort commits ${label} cleanup once when Hub is unavailable`, async () => {
        let home
        try {
            home = await openProductionHome(
                `abort-hub-unavailable-${label}`,
                participant,
                isHost,
                { verify: async () => ({ ok: true, isHost }) },
                { abortBattle: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }) },
            )
            const playId = `abort-hub-unavailable-${label}`
            const started = await home.app.inject({
                method: "POST",
                url: "/start",
                payload: startPayload(participant.viewerId, playId),
            })
            assert.equal(started.statusCode, 200, started.body)
            const callsBeforeAbort = home.coordinatorCalls.length
            const payload = {
                viewer_id: participant.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: playId,
            }

            const aborted = await home.app.inject({ method: "POST", url: "/abort", payload })
            assert.equal(aborted.statusCode, 200, aborted.body)
            assert.equal(getPlayerActiveQuestSync(home.playerId), null)
            assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
            assert.equal(home.coordinatorCalls.length, callsBeforeAbort + 1)

            const repeated = await home.app.inject({ method: "POST", url: "/abort", payload })
            assert.equal(repeated.statusCode, 400, repeated.body)
            assert.equal(getPlayerItemSync(home.playerId, productionQuest.ticketId), 1)
            assert.equal(home.coordinatorCalls.length, callsBeforeAbort + 1)
        } finally {
            await closeProductionHome(home)
        }
    })
}

for (const corruption of ["missing", "battle-session-mismatch"]) {
    test(`production /finish fails closed when SQLite active quest is ${corruption}`, async () => {
        let home
        try {
            home = await openProductionHome(corruption, host, true, {
                verify: async () => ({ ok: true, isHost: true }),
            })
            const playId = `finish-${corruption}`
            const started = await home.app.inject({ method: "POST", url: "/start", payload: startPayload(host.viewerId, playId) })
            assert.equal(started.statusCode, 200, started.body)
            if (corruption === "missing") {
                home.db.prepare("DELETE FROM players_active_quests WHERE player_id = ?").run(home.playerId)
            } else {
                home.db.prepare(`
                    UPDATE players_active_quests SET battle_session_id = 'forged-battle'
                    WHERE player_id = ?
                `).run(home.playerId)
            }
            const before = observableSettlementState(home.db, home.playerId)
            const finished = await home.app.inject({
                method: "POST",
                url: "/finish",
                payload: finishPayload(host.viewerId, playId),
            })
            assert.equal(finished.statusCode, 400, finished.body)
            assert.deepEqual(observableSettlementState(home.db, home.playerId), before)
        } finally {
            await closeProductionHome(home)
        }
    })
}

test("multi routes verify Hub state before opening local write transactions", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/multi/http/battle.ts"),
        "utf8",
    )
    const availability = source.indexOf("context.questAvailability.check(category, quest_id)")
    const roomStatus = source.indexOf("context.coordinator.getRoomStatus(", availability)
    const battleStart = source.indexOf("context.coordinator.startBattle(", roomStatus)
    const entryTransaction = source.indexOf("runStartEntryTransaction({", battleStart)
    const settlementVerification = source.indexOf("context.settlementVerifier.verify(")
    const settlementTransaction = source.indexOf("runMultiActiveQuestSettlementTransaction(")

    assert.ok(availability >= 0)
    assert.ok(roomStatus > availability)
    assert.ok(battleStart > roomStatus)
    assert.ok(entryTransaction > battleStart)
    assert.ok(settlementVerification >= 0 && settlementVerification < settlementTransaction)
    assert.match(source, /battleSessionId:\s*battle\.value\.battleSessionId/)
    assert.doesNotMatch(source, /consumeParticipantFinalizedBattle/)
})
