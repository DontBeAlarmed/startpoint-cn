"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    getBondTokenStatus,
    findMissingBondTokenBoards,
    projectSortedBondTokens,
    isNormalBoardComplete,
    mergeMonotonicAwakeUnlocks,
    assertMonotonicBondTokenTransition,
    validateBondTokenRows,
    validateAwakeUnlockRows,
    validateCharacterReference,
} = require("../src/lib/character-growth/invariants")

test("bond token lookup is keyed and sorted projection is independent of input order", () => {
    const tokens = new Map([
        [2, 1],
        [1, 2],
    ])

    assert.equal(getBondTokenStatus(tokens, 1), 2)
    assert.equal(getBondTokenStatus(tokens, 3), null)
    assert.deepEqual(projectSortedBondTokens(tokens), [
        { mana_board_index: 1, status: 2 },
        { mana_board_index: 2, status: 1 },
    ])
})

test("missing bond token boards are computed from board identity", () => {
    assert.deepEqual(
        findMissingBondTokenBoards(new Map([[1, 2], [3, 1]]), 4),
        [2, 4],
    )
    assert.throws(
        () => findMissingBondTokenBoards(new Map([[3, 1]]), 2),
        error => error.code === "INVALID_GROWTH_STATE",
    )
})

test("normal board completion only requires every content node to be learned", () => {
    assert.equal(
        isNormalBoardComplete(new Set([10, 11, 12]), new Set([10, 11])),
        true,
    )
    assert.equal(
        isNormalBoardComplete(new Set([10, 11]), new Set([10, 11, 12])),
        false,
    )
})

test("awake unlock merge is monotonic and does not delete existing unlocks", () => {
    assert.deepEqual(
        [...mergeMonotonicAwakeUnlocks(
            new Map([[1, 2], [3, 1]]),
            new Map([[1, 1], [2, 3]]),
        )],
        [[1, 2], [3, 1], [2, 3]],
    )
})

test("bond token status only advances one step and permits idempotent replay", () => {
    assert.doesNotThrow(() => assertMonotonicBondTokenTransition(0, 1))
    assert.doesNotThrow(() => assertMonotonicBondTokenTransition(1, 2))
    assert.doesNotThrow(() => assertMonotonicBondTokenTransition(2, 2))
    assert.throws(
        () => assertMonotonicBondTokenTransition(0, 2),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => assertMonotonicBondTokenTransition(2, 1),
        error => error.code === "INVALID_GROWTH_STATE",
    )
})

test("server-boundary validators reject illegal status, duplicate token, awake level, and missing character", () => {
    assert.throws(
        () => validateBondTokenRows([{ character_id: 1, mana_board_index: 1, status: 3 }]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => validateBondTokenRows([
            { character_id: 1, mana_board_index: 1, status: 0 },
            { character_id: 1, mana_board_index: 1, status: 1 },
        ]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => validateAwakeUnlockRows([{ character_id: 1, board_index: 1, awake_level: 0 }]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => validateCharacterReference(99, new Set([1, 2])),
        error => error.code === "CHARACTER_NOT_OWNED",
    )
})
