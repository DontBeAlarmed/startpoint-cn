"use strict"

const assert = require("node:assert/strict")
const { test } = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const {
    createLifecycle,
    decide,
    capacityOf,
    isJoinable,
    isServingMember,
    projectRaisingState,
} = require("../src/multi/lifecycle")

const HOST = "host"
const GUEST = "guest"
const GUEST2 = "guest2"
const GEN = 7
const T0 = 1_000_000
const BATTLE_DEADLINE = 1_000
const CLOSE_DEADLINE = 500

function make(npcCount = 0) {
    return createLifecycle({ roomNumber: "100001", generation: GEN, host: HOST, npcCount })
}

function ok(state, event) {
    const result = decide(state, event)
    assert.equal(result.rejected, undefined, `unexpected rejection: ${result.rejected}`)
    return result
}

function bad(state, event, reason) {
    const result = decide(state, event)
    assert.equal(result.rejected, reason)
    assert.deepEqual(result.effects, [])
    return result
}

function join(state, identity, nowMs = T0) {
    let next = ok(state, { type: "admit", generation: GEN, identity }).state
    next = ok(next, { type: "handshake", generation: GEN, identity }).state
    return ok(next, { type: "enter", generation: GEN, identity, nowMs }).state
}

function readyRoom() {
    let state = join(make(), GUEST)
    state = ok(state, { type: "enter", generation: GEN, identity: HOST, nowMs: T0 + 1 }).state
    state = ok(state, { type: "ready", generation: GEN, identity: HOST, ready: true }).state
    state = ok(state, { type: "ready", generation: GEN, identity: GUEST, ready: true }).state
    return state
}

function battleRoom() {
    const state = readyRoom()
    return ok(state, {
        type: "startBattle",
        generation: GEN,
        identity: HOST,
        battleSessionId: "battle-1",
    }).state
}

function finishBoth(state) {
    let result = ok(state, {
        type: "finish",
        generation: GEN,
        identity: GUEST,
        nowMs: T0 + 10,
        battleDeadlineMs: BATTLE_DEADLINE,
    })
    result = ok(result.state, {
        type: "finish",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 20,
        battleDeadlineMs: BATTLE_DEADLINE,
    })
    return result
}

test("create starts recruiting with the host seated", () => {
    const state = make()
    assert.equal(state.phase, "recruiting")
    assert.deepEqual(state.seats, [HOST])
    assert.equal(capacityOf(state), 3)
    assert.equal(isJoinable(state), true)
    assert.equal(projectRaisingState(state), 2)
})

test("join pipeline: admit → handshake → enter; host enter flips ready", () => {
    let state = join(make(), GUEST)
    assert.deepEqual(state.seats, [HOST, GUEST])
    assert.equal(state.phase, "recruiting")
    assert.equal(state.hostEntryTimeMs, null)

    const result = ok(state, {
        type: "enter",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 1,
    })
    state = result.state
    assert.equal(state.phase, "ready")
    assert.equal(state.hostEntryTimeMs, T0 + 1)
    assert.equal(projectRaisingState(state), 1)
    assert.equal(isServingMember(state, GUEST), true)
    assert.ok(result.effects.some(effect => effect.type === "sendEnterReply" && effect.identity === HOST))
})

test("startBattle is host-only and requires every seat ready", () => {
    let state = readyRoom()
    bad(state, {
        type: "startBattle",
        generation: GEN,
        identity: GUEST,
        battleSessionId: "battle-1",
    }, "HOST_ONLY")

    state = ok(state, { type: "ready", generation: GEN, identity: GUEST, ready: false }).state
    bad(state, {
        type: "startBattle",
        generation: GEN,
        identity: HOST,
        battleSessionId: "battle-1",
    }, "NOT_ALL_READY")

    state = ok(state, { type: "ready", generation: GEN, identity: GUEST, ready: true }).state
    const result = ok(state, {
        type: "startBattle",
        generation: GEN,
        identity: HOST,
        battleSessionId: "battle-1",
    })
    assert.equal(result.state.phase, "battle")
    assert.equal(projectRaisingState(result.state), 4)
    assert.deepEqual(result.state.battleParticipants, [HOST, GUEST])
})

test("finish releases seats but keeps battle participants and state 4", () => {
    const battle = battleRoom()
    let result = ok(battle, {
        type: "finish",
        generation: GEN,
        identity: GUEST,
        nowMs: T0 + 10,
        battleDeadlineMs: BATTLE_DEADLINE,
    })
    assert.equal(result.state.battleFinalized, false)
    assert.deepEqual(result.state.seats, [HOST, GUEST])

    result = ok(result.state, {
        type: "finish",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 20,
        battleDeadlineMs: BATTLE_DEADLINE,
    })
    assert.equal(result.state.battleFinalized, true)
    assert.equal(result.state.phase, "battle")
    assert.equal(projectRaisingState(result.state), 4)
    assert.deepEqual(result.state.seats, [HOST])
    assert.deepEqual(result.state.battleParticipants, [HOST, GUEST])
    assert.equal(isServingMember(result.state, GUEST), true)
    assert.ok(result.effects.some(effect => effect.type === "releaseSeats"))
    assert.ok(result.effects.some(effect => effect.type === "persistBattleRelease"))
    assert.ok(result.effects.some(effect => effect.type === "scheduleGc" && effect.ms === BATTLE_DEADLINE))
})

test("hostReturn is the only 4→1 and requires a finalized battle", () => {
    const battle = battleRoom()
    bad(battle, {
        type: "hostReturn",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 30,
    }, "BATTLE_NOT_FINALIZED")

    const finalized = finishBoth(battle).state
    bad(finalized, {
        type: "hostReturn",
        generation: GEN,
        identity: GUEST,
        nowMs: T0 + 40,
    }, "HOST_ONLY")

    const result = ok(finalized, {
        type: "hostReturn",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 50,
    })
    assert.equal(result.state.phase, "ready")
    assert.equal(projectRaisingState(result.state), 1)
    assert.deepEqual(result.state.seats, [HOST])
    assert.deepEqual(result.state.battleParticipants, [])
    assert.equal(result.state.battleSessionId, null)
    assert.equal(result.state.battleFinalized, false)
    assert.equal(result.state.hostEntryTimeMs, T0 + 50)
    assert.equal(isServingMember(result.state, GUEST), false)
})

test("stale generation is rejected without effects", () => {
    bad(make(), {
        type: "admit",
        generation: GEN + 1,
        identity: GUEST,
    }, "STALE_GENERATION")
})

test("npcCount reduces the real capacity", () => {
    const state = make(2)
    assert.equal(capacityOf(state), 1)
    assert.equal(isJoinable(state), false)
    bad(state, { type: "admit", generation: GEN, identity: GUEST }, "ROOM_FULL")
})

test("disband dismisses every known identity and closes after confirmations", () => {
    const ready = readyRoom()
    bad(ready, {
        type: "disband",
        generation: GEN,
        identity: GUEST,
        nowMs: T0 + 100,
        closeDeadlineMs: CLOSE_DEADLINE,
    }, "HOST_ONLY")

    const closing = ok(ready, {
        type: "disband",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 100,
        closeDeadlineMs: CLOSE_DEADLINE,
    })
    assert.equal(closing.state.phase, "closing")
    assert.equal(projectRaisingState(closing.state), 9)
    assert.deepEqual(
        closing.effects
            .filter(effect => effect.type === "sendDismiss")
            .map(effect => effect.identity)
            .sort(),
        [GUEST, HOST].sort(),
    )

    bad(closing.state, { type: "admit", generation: GEN, identity: GUEST2 }, "ROOM_NOT_JOINABLE")

    let state = ok(closing.state, { type: "closeConfirmed", generation: GEN, identity: HOST }).state
    assert.equal(state.phase, "closing")
    const closed = ok(state, { type: "closeConfirmed", generation: GEN, identity: GUEST })
    assert.equal(closed.state.phase, "closed")
    assert.deepEqual(closed.effects, [{ type: "closeRoom" }])
})

test("a handshaked joiner can complete its entry inside closing", () => {
    let state = make()
    state = ok(state, { type: "admit", generation: GEN, identity: GUEST2 }).state
    state = ok(state, { type: "handshake", generation: GEN, identity: GUEST2 }).state
    state = ok(state, { type: "enter", generation: GEN, identity: HOST, nowMs: T0 + 1 }).state
    state = ok(state, {
        type: "disband",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 2,
        closeDeadlineMs: CLOSE_DEADLINE,
    }).state

    const entered = ok(state, {
        type: "enter",
        generation: GEN,
        identity: GUEST2,
        nowMs: T0 + 3,
    })
    assert.deepEqual(entered.effects.map(effect => effect.type), ["sendEnterReply", "sendDismiss"])
    assert.equal(entered.state.joiners[GUEST2], "entered")

    state = ok(entered.state, { type: "closeConfirmed", generation: GEN, identity: HOST }).state
    const closed = ok(state, { type: "closeConfirmed", generation: GEN, identity: GUEST2 })
    assert.equal(closed.state.phase, "closed")
})

test("socketLost is ignored in battle and marks the host offline in ready", () => {
    const battle = battleRoom()
    const lostInBattle = ok(battle, { type: "socketLost", generation: GEN, identity: HOST })
    assert.equal(lostInBattle.state, battle)
    assert.deepEqual(lostInBattle.effects, [])

    let state = readyRoom()
    let result = ok(state, { type: "socketLost", generation: GEN, identity: HOST })
    assert.equal(result.state.hostOnline, false)
    assert.equal(projectRaisingState(result.state), 2)

    result = ok(result.state, { type: "handshake", generation: GEN, identity: HOST })
    assert.equal(result.state.hostOnline, true)
    assert.equal(projectRaisingState(result.state), 1)

    result = ok(result.state, { type: "socketLost", generation: GEN, identity: GUEST })
    assert.deepEqual(result.state.seats, [HOST])
})

test("guest abort removes the participant and finalizes when the rest finished", () => {
    let state = battleRoom()
    state = ok(state, {
        type: "finish",
        generation: GEN,
        identity: HOST,
        nowMs: T0 + 10,
        battleDeadlineMs: BATTLE_DEADLINE,
    }).state

    const result = ok(state, {
        type: "abort",
        generation: GEN,
        identity: GUEST,
        nowMs: T0 + 20,
        battleDeadlineMs: BATTLE_DEADLINE,
        closeDeadlineMs: CLOSE_DEADLINE,
    })
    assert.equal(result.state.battleFinalized, true)
    assert.deepEqual(result.state.battleParticipants, [HOST])
    assert.deepEqual(result.state.seats, [HOST])
    assert.ok(result.effects.some(effect => effect.type === "releaseSeats"))
    assert.ok(result.effects.some(effect => effect.type === "persistBattleRelease"))
})

test("gcSweep closes a finalized battle after the deadline", () => {
    const finalized = finishBoth(battleRoom()).state
    const closing = ok(finalized, {
        type: "gcSweep",
        generation: GEN,
        nowMs: T0 + 20 + BATTLE_DEADLINE,
        battleDeadlineMs: BATTLE_DEADLINE,
        closeDeadlineMs: CLOSE_DEADLINE,
    })
    assert.equal(closing.state.phase, "closing")
    assert.ok(closing.effects.some(effect => effect.type === "sendDismiss"))

    const closed = ok(closing.state, {
        type: "gcSweep",
        generation: GEN,
        nowMs: T0 + 20 + BATTLE_DEADLINE + CLOSE_DEADLINE,
        battleDeadlineMs: BATTLE_DEADLINE,
        closeDeadlineMs: CLOSE_DEADLINE,
    })
    assert.equal(closed.state.phase, "closed")
    assert.deepEqual(closed.effects, [{ type: "closeRoom" }])
})
