"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    convertLoginBonusTree,
    selectActiveLoginBonusGroups,
    selectActiveNormalLoginBonusGroup,
} = require("../src/content/converters/login-bonus")

function row(values) {
    const fields = Array(48).fill("")
    for (const [index, value] of Object.entries(values)) fields[Number(index)] = String(value)
    return [fields]
}

function group(groupType, startTime, endTime, entries, options = {}) {
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
            38: options.conditionStart ?? "(None)",
            39: options.conditionEnd ?? "(None)",
            40: options.lastLoginDays ?? "(None)",
            41: startTime,
            42: endTime,
            45: 55,
            46: options.linkedComebackGroupId ?? "(None)",
            47: options.includeBeginner ?? "(None)",
        }),
    ]))
}

test("login bonus converter preserves all official group types, eligibility, and rewards", () => {
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
        comeback: group(2, "2024-07-11 12:00:00", "2024-08-22 11:59:59", [
            [1, [{ kind: 1, count: 10, itemId: 101 }]],
        ], {
            conditionStart: "2024-05-23 05:00:00",
            conditionEnd: "2024-07-04 04:59:59",
            lastLoginDays: 30,
            includeBeginner: true,
        }),
        comeback_always: group(3, "2024-07-11 12:00:00", "2024-08-22 11:59:59", [
            [1, [{ kind: 3, count: 1000 }]],
        ]),
        active: group(4, "2024-07-11 12:00:00", "2024-08-22 11:59:59", [
            [1, [{ kind: 4, count: 1000 }]],
        ], { linkedComebackGroupId: "comeback" }),
        comeback_cn: group(5, "2024-05-23 05:00:00", "(None)", [
            [1, [{ kind: 0, count: 100 }]],
        ], {
            conditionStart: "2099-03-19 05:00:00",
            conditionEnd: "2099-03-19 06:00:00",
            lastLoginDays: 30,
            includeBeginner: false,
        }),
        comeback_jp: group(6, "2024-07-11 12:00:00", "2024-08-22 11:59:59", [
            [1, [{ kind: 2, count: 1, characterId: 401 }]],
        ], {
            conditionStart: "2024-05-23 05:00:00",
            conditionEnd: "2024-07-04 04:59:59",
            lastLoginDays: 30,
            includeBeginner: true,
        }),
    })

    assert.deepEqual(
        Object.fromEntries(Object.entries(converted).map(([id, value]) => [id, value.groupType])),
        {
            active: "ActiveUser",
            comeback: "Comeback",
            comeback_always: "ComebackAlways",
            comeback_cn: "ComebackCn",
            comeback_jp: "ComebackJp",
            limited: "Limited",
            normal_current: "Normal",
            normal_old: "Normal",
        },
    )
    assert.deepEqual(converted.comeback, {
        groupType: "Comeback",
        availableFromMs: Date.parse("2024-07-11T04:00:00.000Z"),
        availableUntilMs: Date.parse("2024-08-22T03:59:59.000Z"),
        conditionPeriodFromMs: Date.parse("2024-05-22T21:00:00.000Z"),
        conditionPeriodUntilMs: Date.parse("2024-07-03T20:59:59.000Z"),
        comebackInactivityDays: 30,
        linkedComebackGroupId: null,
        includeBeginner: true,
        entries: [{ index: 1, rewards: [{ kind: 1, id: 101, count: 10 }] }],
    })
    assert.equal(converted.normal_current.conditionPeriodFromMs, null)
    assert.equal(converted.active.linkedComebackGroupId, "comeback")
    assert.equal(converted.comeback_cn.includeBeginner, false)
    assert.equal(Object.isFrozen(converted), true)
    assert.equal(Object.isFrozen(converted.normal_current.entries[2].rewards), true)
})

test("active group selection returns every overlapping group of the requested type", () => {
    const catalog = convertLoginBonusTree({
        limited_a: group(1, "2024-08-01 05:00:00", "2024-08-31 04:59:59", [
            [1, [{ kind: 0, count: 10 }]],
        ]),
        limited_b: group(1, "2024-08-10 05:00:00", "2024-08-20 04:59:59", [
            [1, [{ kind: 0, count: 20 }]],
        ]),
        inactive: group(1, "2024-09-01 05:00:00", "2024-09-30 04:59:59", [
            [1, [{ kind: 0, count: 30 }]],
        ]),
    })

    assert.deepEqual(
        selectActiveLoginBonusGroups(
            catalog,
            "Limited",
            Date.parse("2024-08-14T12:00:00.000Z"),
        ).map(entry => entry.groupId),
        ["limited_a", "limited_b"],
    )
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
