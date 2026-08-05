"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

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

    const started = await coordinator.startBattle({ participant: guest, roomNumber })
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

test("host and guest charge and settle only their own SQLite home save", async t => {
    const { runStartEntryTransaction } = require("../src/lib/quest/start-entry")
    const hub = new BattleFactStore({ createBattleSessionId: () => "shared-battle" })
    const battle = hub.startBattle({ roomNumber: "123456", host, participants: [host, guest] })
    const coordinatorCalls = []
    const coordinator = {
        getBattleStatus: async input => {
            coordinatorCalls.push(structuredClone(input))
            return hub.getBattleStatus(input)
        },
    }

    function home(participant) {
        const db = new Sqlite(":memory:")
        db.exec(`
            CREATE TABLE player (
                id INTEGER PRIMARY KEY,
                stamina INTEGER NOT NULL,
                ticket_count INTEGER NOT NULL,
                reward_count INTEGER NOT NULL DEFAULT 0,
                total_stamina_used INTEGER NOT NULL DEFAULT 0,
                party_slot INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE active_quest (
                player_id INTEGER PRIMARY KEY,
                battle_session_id TEXT NOT NULL
            );
            INSERT INTO player (id, stamina, ticket_count) VALUES (${participant.viewerId}, 100, 1);
        `)
        t.after(() => db.close())
        return { db, participant }
    }

    function start(node, isHost) {
        const activeQuest = { battleSessionId: battle.battleSessionId }
        return runStartEntryTransaction({
            playerId: node.participant.viewerId,
            entryCost: isHost ? { itemId: 9001, itemCount: 1, stamina: 10 } : undefined,
            staminaCost: isHost ? 10 : 0,
            partyId: 1,
            updatePartySlot: false,
            activeQuest,
            now: new Date(0),
        }, {
            transaction: operation => node.db.transaction(operation)(),
            getPlayer: playerId => {
                const row = node.db.prepare("SELECT * FROM player WHERE id = ?").get(playerId)
                return row ? {
                    id: row.id,
                    stamina: row.stamina,
                    staminaHealTime: new Date(0),
                    rankPoint: 0,
                    totalStaminaUsed: row.total_stamina_used,
                    partySlot: row.party_slot,
                } : null
            },
            computeStamina: player => player.stamina,
            getItemCount: playerId => node.db.prepare(
                "SELECT ticket_count FROM player WHERE id = ?",
            ).get(playerId)?.ticket_count ?? null,
            updateItemCount: (playerId, _itemId, amount) => node.db.prepare(
                "UPDATE player SET ticket_count = ? WHERE id = ?",
            ).run(amount, playerId),
            updatePlayer: update => node.db.prepare(`
                UPDATE player
                SET stamina = COALESCE(?, stamina),
                    total_stamina_used = COALESCE(?, total_stamina_used)
                WHERE id = ?
            `).run(update.stamina ?? null, update.totalStaminaUsed ?? null, update.id),
            persistActiveQuest: (playerId, quest) => node.db.prepare(`
                INSERT INTO active_quest (player_id, battle_session_id) VALUES (?, ?)
            `).run(playerId, quest.battleSessionId),
            publishActiveQuest() {},
        })
    }

    async function settle(node) {
        const verifier = new MultiSettlementVerifier(coordinator)
        const verified = await verifier.verify({
            nodeSessionId: node.participant.nodeSessionId,
            viewerId: node.participant.viewerId,
            roomNumber: "123456",
            battleSessionId: battle.battleSessionId,
        })
        if (!verified.ok) return false
        return node.db.transaction(() => {
            const active = node.db.prepare(
                "SELECT battle_session_id FROM active_quest WHERE player_id = ?",
            ).get(node.participant.viewerId)
            if (active?.battle_session_id !== battle.battleSessionId) return false
            node.db.prepare(
                "UPDATE player SET reward_count = reward_count + 1 WHERE id = ?",
            ).run(node.participant.viewerId)
            node.db.prepare("DELETE FROM active_quest WHERE player_id = ?")
                .run(node.participant.viewerId)
            return true
        })()
    }

    const hostHome = home(host)
    const guestHome = home(guest)
    start(hostHome, true)
    start(guestHome, false)
    assert.deepEqual(hostHome.db.prepare(
        "SELECT stamina, ticket_count, total_stamina_used FROM player",
    ).get(), { stamina: 90, ticket_count: 0, total_stamina_used: 10 })
    assert.deepEqual(guestHome.db.prepare(
        "SELECT stamina, ticket_count, total_stamina_used FROM player",
    ).get(), { stamina: 100, ticket_count: 1, total_stamina_used: 0 })
    assert.equal(hostHome.db.prepare("SELECT battle_session_id FROM active_quest").get().battle_session_id, "shared-battle")
    assert.equal(guestHome.db.prepare("SELECT battle_session_id FROM active_quest").get().battle_session_id, "shared-battle")

    hub.markFinalized({ participant: host, roomNumber: "123456", battleSessionId: battle.battleSessionId })
    hub.markFinalized({ participant: guest, roomNumber: "123456", battleSessionId: battle.battleSessionId })
    assert.equal(await settle(hostHome), true)
    assert.equal(await settle(guestHome), true)
    assert.equal(await settle(guestHome), false, "repeat finish must not duplicate local rewards")
    assert.equal(hostHome.db.prepare("SELECT reward_count FROM player").get().reward_count, 1)
    assert.equal(guestHome.db.prepare("SELECT reward_count FROM player").get().reward_count, 1)
    assert.equal(coordinatorCalls.every(call => (
        !Object.hasOwn(call, "database") && !Object.hasOwn(call, "grantRewards")
    )), true)
})

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
    const settlementTransaction = source.indexOf("const executeFinishWrites = () => {")

    assert.ok(availability >= 0)
    assert.ok(roomStatus > availability)
    assert.ok(battleStart > roomStatus)
    assert.ok(entryTransaction > battleStart)
    assert.ok(settlementVerification >= 0 && settlementVerification < settlementTransaction)
    assert.match(source, /battleSessionId:\s*battle\.value\.battleSessionId/)
    assert.doesNotMatch(source, /consumeParticipantFinalizedBattle/)
})
