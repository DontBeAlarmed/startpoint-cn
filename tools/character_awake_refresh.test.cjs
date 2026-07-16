const assert = require("node:assert/strict")

const {
    buildManaBoardAwakeCharacterList,
    mergeManaBoardAwakeMaps,
    validateManaBoardAwakeRequest,
} = require("../out/lib/character-helpers")

function testMissionUnlockAndNodeStateAreMerged() {
    const missionUnlocks = new Map([
        ["101", { 1: 1 }],
        ["102", { 1: 1 }],
    ])
    const nodeState = new Map([
        ["101", { 1: 2 }],
        ["103", { 1: 1 }],
    ])

    assert.deepEqual(
        [...mergeManaBoardAwakeMaps(missionUnlocks, nodeState).entries()],
        [
            ["101", { 1: 2 }],
            ["102", { 1: 1 }],
            ["103", { 1: 1 }],
        ]
    )
}

function testAwakeRequestGate() {
    const boardNodeIds = [101, 102, 103]
    const learnedNodeIds = [101, 102, 103]

    assert.equal(validateManaBoardAwakeRequest([101, 102], 1, 1, boardNodeIds, learnedNodeIds), null)
    assert.equal(validateManaBoardAwakeRequest([101], 1, 0, boardNodeIds, learnedNodeIds), "Awake missions are not complete.")
    assert.equal(validateManaBoardAwakeRequest([101], 2, 1, boardNodeIds, learnedNodeIds), "Invalid awake level.")
    assert.equal(validateManaBoardAwakeRequest([101], 1, 1, boardNodeIds, [101, 102]), "Base mana board is not complete.")
    assert.equal(validateManaBoardAwakeRequest([101, 101], 1, 1, boardNodeIds, learnedNodeIds), "Invalid mana node list.")
    assert.equal(validateManaBoardAwakeRequest([999], 1, 1, boardNodeIds, learnedNodeIds), "Mana node is outside the awake board.")
}

function testAwakeUnlockUsesCommonCharacterResponseShape() {
    const joinedAt = new Date("2026-07-01T01:02:03.000Z")
    const updatedAt = new Date("2026-07-02T04:05:06.000Z")
    const characters = {
        101: {
            entryCount: 1,
            evolutionLevel: 0,
            overLimitStep: 0,
            protection: false,
            joinTime: joinedAt,
            updateTime: updatedAt,
            exp: 123,
            stack: 0,
            manaBoardIndex: 1,
            bondTokenList: [],
        },
    }

    const entries = buildManaBoardAwakeCharacterList(
        characters,
        new Map([
            ["101", { 1: 1 }],
            ["999", { 1: 1 }],
        ])
    )

    assert.equal(entries.length, 1)
    assert.equal(entries[0].character_id, 101)
    assert.equal(entries[0].exp, 123)
    assert.deepEqual(entries[0].mana_board_awake, { 1: 1 })
    assert.equal(typeof entries[0].join_time, "string")
    assert.equal(typeof entries[0].update_time, "string")
}

testMissionUnlockAndNodeStateAreMerged()
testAwakeUnlockUsesCommonCharacterResponseShape()
testAwakeRequestGate()
console.log("character awake refresh tests passed")
