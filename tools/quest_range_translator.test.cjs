"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

let restoreContentSnapshot = () => {}
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const {
    translateMissionQuestRange,
    STANDARD_MISSION_RANGE_LAYOUT,
    COLLECT_MISSION_RANGE_LAYOUT,
} = require("../src/lib/mission/quest-range-translator")

function rowOf(category, missionId) {
    const definition = getMissionCatalog().getDefinition(category, missionId)
    assert.ok(definition, `mission ${category}/${missionId} must exist`)
    return definition.row
}

test("translates the (None) kind as unconstrained", () => {
    const range = translateMissionQuestRange(rowOf(2, 800392), STANDARD_MISSION_RANGE_LAYOUT)
    assert.equal(range.unconstrained, true)
    assert.equal(range.matches(1, 1001001), true)
    assert.equal(range.matches(26, 1001001), true)
})

test("subsumes the 10075 score-attack daily with the empty-suffix wildcard", () => {
    const range = translateMissionQuestRange(rowOf(2, 10075))
    assert.equal(range.matches(27, 1001), true)
    assert.equal(range.matches(27, 1012), true)
    assert.equal(range.matches(27, 2001001), false)
    assert.equal(range.matches(11, 1001), false)
})

test("subsumes the advent daily with an explicit event selector", () => {
    const range = translateMissionQuestRange(rowOf(2, 800115))
    assert.equal(range.matches(7, 200015001), true)
    assert.equal(range.matches(7, 200015005), true)
    assert.equal(range.matches(7, 200016001), false)
    assert.equal(range.matches(2, 1001001), false)
})

test("subsumes the all-boss daily with every selector empty", () => {
    const range = translateMissionQuestRange(rowOf(2, 800124))
    assert.equal(range.matches(2, 1001001), true)
    assert.equal(range.matches(2, 1020003), true)
    assert.equal(range.matches(7, 200015001), false)
})

test("translates the weekevent kind 12 across its four categories", () => {
    const range = translateMissionQuestRange(rowOf(2, 2))
    for (const section of [6, 14, 13, 20]) {
        assert.equal(range.matches(section, 1), true, `kind 12 must cover category ${section}`)
    }
    assert.equal(range.matches(1, 1001001), false)
})

test("translates the rush daily with an event id and suffix list", () => {
    const range = translateMissionQuestRange(rowOf(2, 700001))
    assert.equal(range.matches(24, 700001002), true)
    assert.equal(range.matches(24, 700001004), true)
    assert.equal(range.matches(24, 700001005), false)
    assert.equal(range.matches(24, 700002002), false)
})

test("translates the ranking daily phase mission", () => {
    const range = translateMissionQuestRange(rowOf(2, 200851))
    assert.equal(range.matches(11, 4001), true)
    assert.equal(range.matches(11, 4002), false)
})

test("translates collect rows with the collect column layout", () => {
    const advent = translateMissionQuestRange(rowOf(4, 2102), COLLECT_MISSION_RANGE_LAYOUT)
    assert.equal(advent.matches(7, 100009001), true)
    assert.equal(advent.matches(7, 100009003), true, "empty suffix selector is a wildcard")
    assert.equal(advent.matches(7, 100010001), false)

    const boss = translateMissionQuestRange(rowOf(4, 1653), COLLECT_MISSION_RANGE_LAYOUT)
    assert.equal(boss.matches(2, 1009001), true)
    assert.equal(boss.matches(2, 1009005), true, "third selector (None) is unconstrained")
    assert.equal(boss.matches(2, 1010001), false)
})

test("fails closed on a truly blank or unknown kind column", () => {
    assert.equal(translateMissionQuestRange([], STANDARD_MISSION_RANGE_LAYOUT).unconstrained, true)
    assert.equal(translateMissionQuestRange(["x", "x", "x", "x", "x", "x", "x", "", "1", "2", "3"]), null)
    assert.equal(translateMissionQuestRange(["x", "x", "x", "x", "x", "x", "x", "99", "", "", ""]), null)
})

test.after(() => restoreContentSnapshot())
