require("ts-node/register")

const assert = require("node:assert/strict")
const test = require("node:test")

const { QuestCategory } = require("../src/lib/types")
const { filterRoomsForList } = require("../src/multi/room/listing.ts")

function makeRoom(overrides = {}) {
    return {
        room_number: overrides.room_number ?? "100001",
        access_token: "token",
        category: overrides.category ?? QuestCategory.ADVENT_EVENT_MULTI,
        quest_id: overrides.quest_id ?? 200076002,
        host_viewer_id: overrides.host_viewer_id ?? 9001,
        host_player_id: overrides.host_player_id ?? 9101,
        host_party_id: overrides.host_party_id ?? 1,
        host_main_character_id: overrides.host_main_character_id ?? 101,
        accepted_type: 0,
        created_at: 0,
        raising_state: overrides.raising_state ?? 1,
        room_sequence: overrides.room_sequence ?? 1,
        host_entry_time: overrides.host_entry_time ?? 0,
        mates: overrides.mates ?? [],
        share_room_options: 0,
        is_npc_mode: false,
        npc_count: 0,
    }
}

test("advent room list returns public joinable rooms for the requested event", () => {
    const rooms = [
        makeRoom({ room_number: "advent-target", quest_id: 200076002, host_viewer_id: 9001 }),
        makeRoom({ room_number: "other-advent-event", quest_id: 200071002, host_viewer_id: 9002 }),
        makeRoom({ room_number: "battle-started", quest_id: 200076003, host_viewer_id: 9003, raising_state: 4 }),
        makeRoom({
            room_number: "full-room",
            quest_id: 200076004,
            host_viewer_id: 9004,
            mates: [{ viewer_id: 1, com_id: 1 }, { viewer_id: 2, com_id: 2 }, { viewer_id: 3, com_id: 3 }],
        }),
        makeRoom({ room_number: "wrong-category", category: QuestCategory.MAIN, quest_id: 200076002 }),
    ]

    const visibleRooms = filterRoomsForList(rooms, QuestCategory.ADVENT_EVENT_MULTI, 200076)

    assert.deepEqual(visibleRooms.map((room) => room.room_number), ["advent-target"])
    assert.equal(visibleRooms[0].host_viewer_id, 9001)
})

test("room list keeps category behavior when no event id is requested", () => {
    const rooms = [
        makeRoom({ room_number: "first", quest_id: 200076002 }),
        makeRoom({ room_number: "second", quest_id: 200071002 }),
        makeRoom({ room_number: "wrong-category", category: QuestCategory.MAIN, quest_id: 200076002 }),
    ]

    const visibleRooms = filterRoomsForList(rooms, QuestCategory.ADVENT_EVENT_MULTI)

    assert.deepEqual(visibleRooms.map((room) => room.room_number), ["first", "second"])
})
