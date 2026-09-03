"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    projectItemOverflowCommonResponse,
} = require("../src/lib/item-overflow/common-response")

test("projects Mail and Sold dispositions to the exact CN over_max wire shape", () => {
    const input = [
        Object.freeze({ kind: "mail", itemId: 30102, overflowAmount: 20 }),
        Object.freeze({
            kind: "sold",
            itemId: 1,
            overflowAmount: 12,
            soldMana: 60,
            manaBefore: 100,
            acceptedMana: 60,
            overflowMana: 0,
            manaAfter: 160,
        }),
    ]

    assert.deepEqual(projectItemOverflowCommonResponse(input), [
        {
            process_type: 1,
            item: { item_id: 30102, number: 20 },
        },
        {
            process_type: 2,
            amount_sold: 60,
            item: { item_id: 1, number: 12 },
        },
    ])
})

test("empty dispositions produce no synthetic Toast entries", () => {
    assert.deepEqual(projectItemOverflowCommonResponse([]), [])
})

test("projector preserves order and returns recursively frozen owned values", () => {
    const source = [
        { kind: "mail", itemId: 30102, overflowAmount: 1 },
        { kind: "mail", itemId: 30101, overflowAmount: 2 },
    ]
    const projected = projectItemOverflowCommonResponse(source)

    source[0].overflowAmount = 999
    assert.deepEqual(projected.map(entry => entry.item.number), [1, 2])
    assert.equal(Object.isFrozen(projected), true)
    assert.equal(Object.isFrozen(projected[0]), true)
    assert.equal(Object.isFrozen(projected[0].item), true)
    assert.throws(() => { projected[0].item.number = 999 })
})

test("projector rejects malformed disposition values instead of guessing", () => {
    for (const input of [
        null,
        [{}],
        [{ kind: "mail", itemId: 0, overflowAmount: 1 }],
        [{ kind: "mail", itemId: 1, overflowAmount: 0 }],
        [{ kind: "sold", itemId: 1, overflowAmount: 1, soldMana: -1 }],
        [{ kind: "discard", itemId: 1, overflowAmount: 1 }],
    ]) {
        assert.throws(() => projectItemOverflowCommonResponse(input))
    }
})
