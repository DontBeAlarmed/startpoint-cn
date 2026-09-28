"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    sendCharacterResponse,
} = require("../src/lib/character-helpers")

function captureReply() {
    const captured = { payload: undefined }
    const sender = { send: payload => { captured.payload = payload } }
    return {
        header: () => sender,
        status: () => sender,
        captured,
    }
}

test("character response projection applies the entity whitelist and canonical identity", () => {
    const reply = captureReply()
    sendCharacterResponse(reply, 900, {
        user_info: { free_mana: 3 },
        character_list: [{ character_id: 101, stack: 2, junk_field: "leak" }],
        user_character_mana_node_list: { 101: [] },
        item_list: { 990008: 4 },
        evolution: [],
        mail_arrived: true,
    })
    const data = reply.captured.payload.data
    assert.deepEqual(data.user_info, { free_mana: 3 })
    assert.deepEqual(data.character_list, [{ character_id: 101, stack: 2 }])
    assert.deepEqual(data.user_character_mana_node_list, { 101: [] })
    assert.deepEqual(data.item_list, { 990008: 4 })
    assert.deepEqual(data.evolution, [])
    assert.equal(data.mail_arrived, true)
    assert.equal("mission_info" in data, false)
    assert.equal("equipment_list" in data, false)
})

test("character response projection rejects non-canonical identity", () => {
    assert.throws(() => sendCharacterResponse(captureReply(), 900, {
        user_info: {},
        character_list: [{ character_id: 0 }],
        user_character_mana_node_list: {},
        item_list: {},
        evolution: [],
        mail_arrived: false,
    }), TypeError)
})
