"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    projectCharacterGrowthIncrement,
} = require("../src/lib/character-growth/response-projector")

function character(overrides = {}) {
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: new Date("2024-08-14T12:00:00.000Z"),
        updateTime: new Date("2024-08-14T12:01:00.000Z"),
        exp: 5,
        stack: 1,
        manaBoardIndex: 1,
        bondTokenList: [{ manaBoardIndex: 1, status: 0 }],
        ...overrides,
    }
}

function after(overrides = {}) {
    return {
        playerId: 7,
        characterId: 1,
        rarity: 4,
        exp: 900,
        stack: 3,
        protection: true,
        overLimitStep: 2,
        evolutionLevel: 1,
        manaBoardIndex: 2,
        bondTokens: new Map([[2, 1], [1, 2]]),
        normalManaNodes: new Map([[101, 0], [102, 1]]),
        awakeUnlocks: new Map([[1, 1]]),
        ...overrides,
    }
}

test("increment projector publishes only authoritative after-state and keeps keyed ordering", () => {
    const projection = projectCharacterGrowthIncrement(
        { after: after(), changedNodeIds: [102, 101] },
        {
            character: character(),
            viewerId: 88,
            // A stale transport override must never win over result.after.
            manaBoardAwake: { 1: 9 },
            fields: [
                "exp",
                "stack",
                "protection",
                "mana_board_index",
                "bond_token_list",
                "mana_board_awake",
                "update_time",
            ],
            includeChangedNodes: true,
        },
    )

    assert.deepEqual(projection.character_list, [{
        viewer_id: 88,
        character_id: 1,
        exp: 900,
        stack: 3,
        protection: true,
        mana_board_index: 2,
        bond_token_list: [
            { mana_board_index: 1, status: 2 },
            { mana_board_index: 2, status: 1 },
        ],
        mana_board_awake: { 1: 1 },
        update_time: "2024-08-14 12:01:00",
    }])
    assert.deepEqual(projection.user_character_mana_node_list, {
        1: [
            { multiplied_id: 102, awake_level: 1 },
            { multiplied_id: 101, awake_level: 0 },
        ],
    })
})

test("increment projector reads board and Awake only from after-state and omits an empty map", () => {
    const projection = projectCharacterGrowthIncrement(
        {
            after: after({
                manaBoardIndex: 2,
                awakeUnlocks: new Map(),
            }),
            changedNodeIds: [],
        },
        {
            character: character({ manaBoardIndex: 1 }),
            fields: ["mana_board_index", "mana_board_awake"],
        },
    )
    assert.deepEqual(projection.character_list, [{ character_id: 1, mana_board_index: 2 }])
    assert.equal("mana_board_awake" in projection.character_list[0], false)
})

test("projector rejects malformed server results at its pure boundary", () => {
    assert.throws(
        () => projectCharacterGrowthIncrement(
            { after: after({ exp: -1 }), changedNodeIds: [] },
            { character: character(), fields: ["exp"] },
        ),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => projectCharacterGrowthIncrement(
            { after: after({ normalManaNodes: new Map([[101, 0]]) }), changedNodeIds: [102] },
            { character: character(), fields: ["exp"], includeChangedNodes: true },
        ),
        error => error.code === "INVALID_GROWTH_STATE",
    )
})

test("response projector remains database-free", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/lib/character-growth/response-projector.ts"),
        "utf8",
    )
    assert.doesNotMatch(source, /data\/db|data\/domains/)
})
