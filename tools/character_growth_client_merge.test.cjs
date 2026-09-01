"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    projectCharacterGrowthIncrement,
} = require("../src/lib/character-growth/response-projector")

// CN 1.8.1 characterization sources:
// PlayerLogic.applyCommonResponseCharacterList (PlayerLogic.as:3113-3225),
// OwnedCharacterLogic.applyBondTokenList/applyManaBoardAwake (851-870, 923-940),
// and the learn/awake processing flows' appendManaNodes calls.

function applyCommonResponseCharacter(local, response) {
    const next = structuredClone(local)
    if (Object.prototype.hasOwnProperty.call(response, "bond_token_list")) {
        next.bond_token_list = structuredClone(response.bond_token_list)
    }
    if (Object.prototype.hasOwnProperty.call(response, "mana_board_index")) {
        next.mana_board_index = response.mana_board_index
    }
    if (Object.prototype.hasOwnProperty.call(response, "mana_board_awake")) {
        next.mana_board_awake = {
            ...next.mana_board_awake,
            ...response.mana_board_awake,
        }
    }
    return next
}

function appendManaNodes(localNodes, entries) {
    const next = new Map(localNodes)
    for (const entry of entries) next.set(entry.multiplied_id, entry.awake_level)
    return next
}

const local = {
    bond_token_list: [{ mana_board_index: 1, status: 2 }],
    mana_board_index: 1,
    mana_board_awake: { 1: 1 },
}

test("CN common character merge keeps omitted Options and replaces present scalar/list fields", () => {
    assert.deepEqual(applyCommonResponseCharacter(local, {}), local)
    assert.deepEqual(applyCommonResponseCharacter(local, {
        bond_token_list: [{ mana_board_index: 2, status: 0 }],
        mana_board_index: 2,
    }), {
        bond_token_list: [{ mana_board_index: 2, status: 0 }],
        mana_board_index: 2,
        mana_board_awake: { 1: 1 },
    })
})

test("CN mana_board_awake merges by key; an empty map never deletes old keys", () => {
    assert.deepEqual(
        applyCommonResponseCharacter(local, { mana_board_awake: { 2: 1 } }).mana_board_awake,
        { 1: 1, 2: 1 },
    )
    assert.deepEqual(
        applyCommonResponseCharacter(local, { mana_board_awake: {} }).mana_board_awake,
        { 1: 1 },
    )

    const character = {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: new Date("2024-08-14T12:00:00.000Z"),
        updateTime: new Date("2024-08-14T12:00:00.000Z"),
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [{ manaBoardIndex: 1, status: 2 }],
    }
    const after = {
        playerId: 7,
        characterId: 1,
        rarity: 4,
        exp: 0,
        stack: 0,
        protection: false,
        overLimitStep: 0,
        evolutionLevel: 0,
        manaBoardIndex: 1,
        bondTokens: new Map([[1, 2]]),
        awakeUnlocks: new Map(),
    }
    const emptyProjection = projectCharacterGrowthIncrement(
        { after, changedNodeIds: [] },
        { character, fields: ["mana_board_awake"] },
    ).character_list[0]
    assert.equal("mana_board_awake" in emptyProjection, false)
    assert.deepEqual(applyCommonResponseCharacter(local, emptyProjection).mana_board_awake, { 1: 1 })
})

test("CN learn/awake node flow overwrites or appends by node id", () => {
    const merged = appendManaNodes(new Map([[101, 0], [102, 0]]), [
        { multiplied_id: 102, awake_level: 1 },
        { multiplied_id: 103, awake_level: 1 },
    ])
    assert.deepEqual([...merged], [[101, 0], [102, 1], [103, 1]])
})
