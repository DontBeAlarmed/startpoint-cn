"use strict"

const assert = require("node:assert/strict")
const { test } = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const {
    identityOf,
    lifecycleRegistry,
    projectRaisingState,
} = require("../src/multi/lifecycle")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")

function dispatch(roomNumber, build) {
    const result = lifecycleRegistry.dispatch(roomNumber, build)
    assert.ok(result, `no lifecycle state for room ${roomNumber}`)
    return result
}

test("identityOf uses the stable viewer key", () => {
    assert.equal(identityOf({ viewerId: 101 }), "viewer:101")
    assert.equal(identityOf({ viewerId: 101 }), identityOf({ viewerId: 101 }))
})

test("registry drives a full lifecycle", () => {
    lifecycleRegistry.reset()
    lifecycleRegistry.create("100001", "viewer:1")

    dispatch("100001", generation => ({ type: "admit", generation, identity: "viewer:2" }))
    dispatch("100001", generation => ({ type: "handshake", generation, identity: "viewer:2" }))
    dispatch("100001", generation => ({
        type: "enter", generation, identity: "viewer:2", nowMs: 10,
    }))
    dispatch("100001", generation => ({
        type: "enter", generation, identity: "viewer:1", nowMs: 11,
    }))
    assert.equal(lifecycleRegistry.get("100001").phase, "ready")
    assert.equal(projectRaisingState(lifecycleRegistry.get("100001")), 1)

    dispatch("100001", generation => ({
        type: "ready", generation, identity: "viewer:1", ready: true,
    }))
    dispatch("100001", generation => ({
        type: "ready", generation, identity: "viewer:2", ready: true,
    }))
    dispatch("100001", generation => ({
        type: "startBattle", generation, identity: "viewer:1", battleSessionId: "battle-1",
    }))
    assert.equal(lifecycleRegistry.get("100001").phase, "battle")
    assert.equal(projectRaisingState(lifecycleRegistry.get("100001")), 4)

    dispatch("100001", generation => ({
        type: "finish", generation, identity: "viewer:2", nowMs: 20, battleDeadlineMs: 1000,
        battleSessionId: "battle-1",
    }))
    dispatch("100001", generation => ({
        type: "finish", generation, identity: "viewer:1", nowMs: 21, battleDeadlineMs: 1000,
        battleSessionId: "battle-1",
    }))
    assert.equal(lifecycleRegistry.get("100001").battleFinalized, true)

    dispatch("100001", generation => ({
        type: "hostReturn", generation, identity: "viewer:1", nowMs: 30,
    }))
    assert.equal(lifecycleRegistry.get("100001").phase, "ready")
    assert.equal(projectRaisingState(lifecycleRegistry.get("100001")), 1)

    lifecycleRegistry.remove("100001")
    assert.equal(lifecycleRegistry.get("100001"), undefined)
})

test("dispatch returns null for a missing room", () => {
    lifecycleRegistry.reset()
    assert.equal(lifecycleRegistry.dispatch("999999", generation => ({
        type: "admit", generation, identity: "viewer:2",
    })), null)
})

test("a stale generation is rejected without changing the state", () => {
    lifecycleRegistry.reset()
    const state = lifecycleRegistry.create("100002", "viewer:1")
    const result = dispatch("100002", () => ({
        type: "admit", generation: state.generation + 999, identity: "viewer:2",
    }))
    assert.equal(result.rejected, "STALE_GENERATION")
    assert.equal(lifecycleRegistry.get("100002"), state)
})

test("createRoom and disbandRoom wire the registry", () => {
    lifecycleRegistry.reset()
    const room = createRoom(101, 201, 1, 1, 301, 1, 401)
    const state = lifecycleRegistry.get(room.room_number)
    assert.ok(state)
    assert.equal(state.host, "viewer:101")
    assert.deepEqual(state.seats, ["viewer:101"])
    assert.equal(state.phase, "recruiting")

    assert.equal(disbandRoom(room.room_number), true)
    assert.equal(lifecycleRegistry.get(room.room_number), undefined)
})

test("rejected events are counted for shadow observation", () => {
    lifecycleRegistry.reset()
    const state = lifecycleRegistry.create("100005", "viewer:1")
    const result = dispatch("100005", () => ({
        type: "admit", generation: state.generation + 999, identity: "viewer:2",
    }))
    assert.equal(result.rejected, "STALE_GENERATION")
    assert.equal(lifecycleRegistry.stats().rejections, 1)
    lifecycleRegistry.reset()
    assert.equal(lifecycleRegistry.stats().rejections, 0)
})

test("a stale generation override is rejected without changing the state", () => {
    lifecycleRegistry.reset()
    const state = lifecycleRegistry.create("100006", "viewer:1")
    const accepted = lifecycleRegistry.dispatch("100006", generation => ({
        type: "admit", generation, identity: "viewer:2",
    }), state.generation)
    assert.equal(accepted.rejected, undefined)
    const stale = lifecycleRegistry.dispatch("100006", generation => ({
        type: "handshake", generation, identity: "viewer:2",
    }), state.generation + 999)
    assert.equal(stale.rejected, "STALE_GENERATION")
})

test("closing entries are swept after the close deadline", () => {
    lifecycleRegistry.reset()
    lifecycleRegistry.create("100007", "viewer:1")
    const closing = lifecycleRegistry.dispatch("100007", generation => ({
        type: "disband", generation, identity: null, nowMs: 1_000, closeDeadlineMs: 500,
    }))
    assert.equal(closing.state.phase, "closing")
    const entries = lifecycleRegistry.closingEntries(1_200)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].roomNumber, "100007")
    assert.equal(entries[0].ageMs, 200)
    assert.deepEqual(entries[0].pendingIdentities, ["viewer:1"])
    assert.equal(lifecycleRegistry.sweepClosing(1_499, 500), 0)
    assert.equal(lifecycleRegistry.sweepClosing(1_500, 500), 1)
    assert.equal(lifecycleRegistry.get("100007"), undefined)
})

test("reset clears every tracked room", () => {
    lifecycleRegistry.reset()
    lifecycleRegistry.create("100003", "viewer:1")
    lifecycleRegistry.create("100004", "viewer:2")
    assert.equal(lifecycleRegistry.size, 2)
    lifecycleRegistry.reset()
    assert.equal(lifecycleRegistry.size, 0)
})
