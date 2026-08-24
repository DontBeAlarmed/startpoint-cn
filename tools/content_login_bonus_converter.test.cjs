"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    convertLoginBonusTree,
    selectActiveNormalLoginBonusGroup,
} = require("../src/content/converters/login-bonus")

function row(values) {
    const fields = Array(48).fill("")
    for (const [index, value] of Object.entries(values)) fields[Number(index)] = String(value)
    return [fields]
}

function group(groupType, startTime, endTime, entries) {
    return Object.fromEntries(entries.map(([index, rewards]) => [
        String(index),
        row({
            0: groupType,
            6: rewards[0]?.kind ?? "(None)",
            7: rewards[0]?.count ?? "",
            8: rewards[0]?.itemId ?? "",
            9: rewards[0]?.characterId ?? "",
            10: rewards[1]?.kind ?? "(None)",
            11: rewards[1]?.count ?? "",
            12: rewards[1]?.itemId ?? "",
            13: rewards[1]?.characterId ?? "",
            37: 780,
            41: startTime,
            42: endTime,
            45: 55,
            46: "(None)",
            47: "(None)",
        }),
    ]))
}

test("login bonus converter preserves authoritative Normal groups and rewards", () => {
    const converted = convertLoginBonusTree({
        normal_old: group(0, "2021-12-09 05:00:00", "2023-08-25 04:59:59", [
            [1, [{ kind: 0, count: 50 }]],
        ]),
        normal_current: group(0, "2023-08-25 05:00:00", "2050-01-01 04:59:59", [
            [1, [{ kind: 0, count: 50 }]],
            [2, [{ kind: 1, count: 6, itemId: 101 }]],
            [3, [
                { kind: 3, count: 1500 },
                { kind: 4, count: 5000 },
            ]],
            [4, [{ kind: 2, count: 1, characterId: 401 }]],
        ]),
        limited: group(1, "2023-08-25 05:00:00", "2050-01-01 04:59:59", [
            [1, [{ kind: 0, count: 999 }]],
        ]),
    })

    assert.deepEqual(converted, {
        normal_current: {
            availableFromMs: Date.parse("2023-08-24T21:00:00.000Z"),
            availableUntilMs: Date.parse("2049-12-31T20:59:59.000Z"),
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 50 }] },
                { index: 2, rewards: [{ kind: 1, id: 101, count: 6 }] },
                { index: 3, rewards: [{ kind: 3, count: 1500 }, { kind: 4, count: 5000 }] },
                { index: 4, rewards: [{ kind: 2, id: 401, count: 1 }] },
            ],
        },
        normal_old: {
            availableFromMs: Date.parse("2021-12-08T21:00:00.000Z"),
            availableUntilMs: Date.parse("2023-08-24T20:59:59.000Z"),
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 50 }] },
            ],
        },
    })
    assert.equal(Object.isFrozen(converted), true)
    assert.equal(Object.isFrozen(converted.normal_current.entries[2].rewards), true)
})

test("active Normal group selection follows inclusive CDN periods", () => {
    const catalog = convertLoginBonusTree({
        normal_old: group(0, "2021-12-09 05:00:00", "2023-08-25 04:59:59", [
            [1, [{ kind: 0, count: 50 }]],
        ]),
        normal_current: group(0, "2023-08-25 05:00:00", "2050-01-01 04:59:59", [
            [1, [{ kind: 0, count: 50 }]],
            [2, [{ kind: 1, count: 6, itemId: 101 }]],
        ]),
    })

    assert.equal(
        selectActiveNormalLoginBonusGroup(catalog, Date.parse("2023-08-24T20:59:59.000Z"))?.groupId,
        "normal_old",
    )
    assert.equal(
        selectActiveNormalLoginBonusGroup(catalog, Date.parse("2023-08-24T21:00:00.000Z"))?.groupId,
        "normal_current",
    )
    assert.equal(
        selectActiveNormalLoginBonusGroup(catalog, Date.parse("2049-12-31T20:59:59.000Z"))?.groupId,
        "normal_current",
    )
    assert.equal(
        selectActiveNormalLoginBonusGroup(catalog, Date.parse("2050-01-01T00:00:00.000Z")),
        null,
    )
})

test("overlapping Normal groups follow the client earliest-start selection", () => {
    const catalog = convertLoginBonusTree({
        earlier: group(0, "2023-08-25 05:00:00", "2050-01-01 04:59:59", [
            [1, [{ kind: 0, count: 50 }]],
        ]),
        later: group(0, "2024-01-01 05:00:00", "2050-01-01 04:59:59", [
            [1, [{ kind: 0, count: 100 }]],
        ]),
    })

    assert.equal(
        selectActiveNormalLoginBonusGroup(catalog, Date.parse("2024-08-14T04:00:00.000Z"))?.groupId,
        "earlier",
    )
})

test("login bonus converter rejects malformed or ambiguous Normal content", () => {
    assert.throws(
        () => convertLoginBonusTree({
            broken: group(0, "2023-02-30 05:00:00", "2050-01-01 04:59:59", [
                [1, [{ kind: 0, count: 50 }]],
            ]),
        }),
        /invalid login bonus content.*availableFrom/i,
    )

    assert.throws(
        () => convertLoginBonusTree({
            broken: {
                "2": row({
                    0: 0,
                    6: 0,
                    7: 50,
                    37: 780,
                    41: "2023-08-25 05:00:00",
                    42: "2050-01-01 04:59:59",
                    45: 55,
                    46: "(None)",
                    47: "(None)",
                }),
            },
        }),
        /indices must start at 1 and be contiguous/i,
    )

    assert.throws(
        () => convertLoginBonusTree({
            broken: group(0, "2023-08-25 05:00:00", "2050-01-01 04:59:59", [
                [1, [{ kind: 2, count: 2, characterId: 401 }]],
            ]),
        }),
        /invalid login bonus content.*character.*count.*exactly 1/i,
    )
})
