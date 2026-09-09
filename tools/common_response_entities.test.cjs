"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    projectCharacterPatch,
    projectEquipmentEntity,
    projectNewCharacterSnapshot,
} = require("../src/lib/common-response/entities")
const {
    mergeCommonResponseFragments,
} = require("../src/lib/common-response/merge")

function newCharacter(overrides = {}) {
    return {
        character_id: 101,
        entry_count: 1,
        bond_token_list: [{ mana_board_index: 1, status: 0 }],
        join_time: "2026-09-08 00:00:00",
        update_time: "2026-09-08 00:00:00",
        ...overrides,
    }
}

function equipment(overrides = {}) {
    return {
        equipment_id: 201,
        protection: false,
        level: 1,
        enhancement_level: 0,
        stack: 0,
        ...overrides,
    }
}

test("Character patch preserves provided zero/false protocol fields and drops non-protocol fields", () => {
    assert.deepEqual(projectCharacterPatch({
        character_id: 101,
        viewer_id: 0,
        exp: 0,
        stack: 0,
        protection: false,
        update_time: "2026-09-08 00:00:00",
        internal_owner_flag: true,
    }), {
        character_id: 101,
        viewer_id: 0,
        exp: 0,
        stack: 0,
        protection: false,
        update_time: "2026-09-08 00:00:00",
    })
})

test("Character patch rejects a missing or invalid canonical ID", () => {
    for (const character_id of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => projectCharacterPatch({ character_id, stack: 0 }),
            /character_id/,
        )
    }
})

test("new Character snapshot requires owner-provided creation fields but keeps exp optional", () => {
    assert.deepEqual(projectNewCharacterSnapshot(newCharacter()), newCharacter())

    for (const field of [
        "character_id",
        "entry_count",
        "bond_token_list",
        "join_time",
        "update_time",
    ]) {
        const incomplete = newCharacter()
        delete incomplete[field]
        assert.throws(() => projectNewCharacterSnapshot(incomplete), new RegExp(field))
    }
})

test("Equipment final entity requires the five typed client fields", () => {
    assert.deepEqual(projectEquipmentEntity(equipment()), equipment())

    for (const field of [
        "equipment_id",
        "protection",
        "level",
        "enhancement_level",
        "stack",
    ]) {
        const incomplete = equipment()
        delete incomplete[field]
        assert.throws(() => projectEquipmentEntity(incomplete), new RegExp(field))
    }
    for (const [field, value] of [
        ["equipment_id", "201"],
        ["protection", 0],
        ["level", "1"],
        ["enhancement_level", false],
        ["stack", "0"],
    ]) {
        assert.throws(
            () => projectEquipmentEntity(equipment({ [field]: value })),
            new RegExp(field),
        )
    }
})

test("same-ID fragments merge to complete entities at their first-seen positions", () => {
    const merged = mergeCommonResponseFragments([
        {
            character_list: [
                projectCharacterPatch(newCharacter({ character_id: 101, stack: 0 })),
                projectCharacterPatch({ character_id: 102, stack: 3 }),
            ],
            equipment_list: [],
        },
        {
            character_list: [projectCharacterPatch({ character_id: 101, stack: 4 })],
            equipment_list: [
                { equipment_id: 201, protection: false, level: 1 },
                equipment({ equipment_id: 202, stack: 2 }),
            ],
        },
        {
            equipment_list: [{ equipment_id: 201, enhancement_level: 0, stack: 5 }],
        },
    ])

    assert.deepEqual(merged.character_list.map(entry => entry.character_id), [101, 102])
    assert.deepEqual(projectNewCharacterSnapshot(merged.character_list[0]), newCharacter({ stack: 4 }))
    assert.deepEqual(merged.equipment_list.map(entry => entry.equipment_id), [201, 202])
    assert.deepEqual(projectEquipmentEntity(merged.equipment_list[0]), equipment({ stack: 5 }))
})

test("entity adapters isolate each finite mutable protocol container", () => {
    const characterInput = newCharacter({
        mana_board_awake: { 1: 1 },
        ex_boost: { status_id: 1, ability_id_list: [10, 20] },
        illustration_settings: [0, 1],
    })
    const characterOutput = projectNewCharacterSnapshot(characterInput)
    const equipmentInput = equipment()
    const equipmentOutput = projectEquipmentEntity(equipmentInput)

    characterInput.bond_token_list[0].status = 9
    characterInput.mana_board_awake[1] = 9
    characterInput.ex_boost.ability_id_list[0] = 99
    characterInput.illustration_settings[0] = 99
    equipmentInput.stack = 9

    assert.deepEqual(characterOutput.bond_token_list, [{ mana_board_index: 1, status: 0 }])
    assert.deepEqual(characterOutput.mana_board_awake, { 1: 1 })
    assert.deepEqual(characterOutput.ex_boost, { status_id: 1, ability_id_list: [10, 20] })
    assert.deepEqual(characterOutput.illustration_settings, [0, 1])
    assert.equal(equipmentOutput.stack, 0)

    characterOutput.bond_token_list[0].status = 8
    characterOutput.mana_board_awake[1] = 8
    characterOutput.ex_boost.ability_id_list[0] = 88
    characterOutput.illustration_settings[0] = 88
    equipmentOutput.stack = 8

    assert.equal(characterInput.bond_token_list[0].status, 9)
    assert.equal(characterInput.mana_board_awake[1], 9)
    assert.equal(characterInput.ex_boost.ability_id_list[0], 99)
    assert.equal(characterInput.illustration_settings[0], 99)
    assert.equal(equipmentInput.stack, 9)
})
