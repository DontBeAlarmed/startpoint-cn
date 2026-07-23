const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { createRoom, disbandRoom } = require("../src/multi/room/manager")

let nicknamePool = {}
try {
    nicknamePool = require("../src/multi/npc/nickname-pool")
} catch {
    // RED: nickname pool module does not exist yet.
}

const { ensureNpcRoster, getActiveNpcRoster, sampleWithoutReplacement } = nicknamePool

function createTestRoom() {
    return createRoom(101, 201, 1, 1, 301, 1, 401, true)
}

test("samples without replacement with a fixed random source and preserves input", () => {
    assert.equal(typeof sampleWithoutReplacement, "function")
    const names = ["A", "B", "C", "D"]
    const randomValues = [2, 0]

    const sampled = sampleWithoutReplacement(names, 2, upperExclusive => {
        assert.equal(upperExclusive, randomValues.length === 2 ? 4 : 3)
        return randomValues.shift()
    })

    assert.deepEqual(sampled, ["C", "B"])
    assert.deepEqual(names, ["A", "B", "C", "D"])
})

test("treats Chinese and emoji nicknames as ordinary strings", () => {
    assert.equal(typeof sampleWithoutReplacement, "function")
    assert.deepEqual(
        sampleWithoutReplacement(["风来人", "星星✨"], 2, () => 0),
        ["风来人", "星星✨"],
    )
})

test("clamps sample count to zero through two", () => {
    assert.equal(typeof sampleWithoutReplacement, "function")
    assert.deepEqual(sampleWithoutReplacement(["A", "B", "C"], -1, () => 0), [])
    assert.deepEqual(sampleWithoutReplacement(["A", "B", "C"], 9, () => 0), ["A", "B"])
})

test("rejects an out-of-range random index", () => {
    assert.equal(typeof sampleWithoutReplacement, "function")
    assert.throws(
        () => sampleWithoutReplacement(["A", "B"], 1, upperExclusive => upperExclusive),
        /random index.*out of range/i,
    )
})

test("creates rooms with an empty NPC roster", t => {
    const room = createTestRoom()
    t.after(() => disbandRoom(room.room_number))

    assert.deepEqual(room.npc_roster, [])
})

test("binds two NPC slots once and keeps the roster stable", t => {
    assert.equal(typeof ensureNpcRoster, "function")
    const room = createTestRoom()
    t.after(() => disbandRoom(room.room_number))

    const first = ensureNpcRoster(room, 2, ["甲", "乙"], () => 0)
    const second = ensureNpcRoster(room, 2, ["丙", "丁"], () => {
        throw new Error("idempotent ensure must not sample again")
    })

    assert.deepEqual(first, [
        { com_id: 1, name: "甲" },
        { com_id: 2, name: "乙" },
    ])
    assert.equal(second, first)
    assert.deepEqual(room.npc_roster, first)
})

test("expanding from one NPC to two only fills the missing slot", t => {
    assert.equal(typeof ensureNpcRoster, "function")
    const room = createTestRoom()
    t.after(() => disbandRoom(room.room_number))

    const first = ensureNpcRoster(room, 1, ["甲", "乙"], () => 0)
    const firstAssignment = first[0]
    const expanded = ensureNpcRoster(room, 2, ["甲", "乙"], () => 0)

    assert.equal(expanded[0], firstAssignment)
    assert.deepEqual(expanded, [
        { com_id: 1, name: "甲" },
        { com_id: 2, name: "乙" },
    ])
})

test("falls back in order when candidates are insufficient without duplicate names", t => {
    assert.equal(typeof ensureNpcRoster, "function")
    const room = createTestRoom()
    t.after(() => disbandRoom(room.room_number))

    const roster = ensureNpcRoster(room, 2, ["开心超人", "开心超人"], () => 0)

    assert.deepEqual(roster, [
        { com_id: 1, name: "开心超人" },
        { com_id: 2, name: "名字真难取" },
    ])
    assert.equal(new Set(roster.map(assignment => assignment.name)).size, roster.length)
})

test("keeps com_id 2 active when one NPC remains", t => {
    assert.equal(typeof ensureNpcRoster, "function")
    assert.equal(typeof getActiveNpcRoster, "function")
    const room = createTestRoom()
    t.after(() => disbandRoom(room.room_number))
    ensureNpcRoster(room, 2, ["甲", "乙"], () => 0)

    assert.deepEqual(getActiveNpcRoster(room, 1), [{ com_id: 2, name: "乙" }])
    assert.deepEqual(getActiveNpcRoster(room, 2), [
        { com_id: 1, name: "甲" },
        { com_id: 2, name: "乙" },
    ])
})

test("a new room starts with a new empty roster after disband", () => {
    assert.equal(typeof ensureNpcRoster, "function")
    const firstRoom = createTestRoom()
    ensureNpcRoster(firstRoom, 2, ["甲", "乙"], () => 0)
    const firstRoster = firstRoom.npc_roster
    assert.equal(disbandRoom(firstRoom.room_number), true)

    const secondRoom = createTestRoom()
    try {
        assert.deepEqual(secondRoom.npc_roster, [])
        assert.notEqual(secondRoom.npc_roster, firstRoster)
    } finally {
        disbandRoom(secondRoom.room_number)
    }
})
