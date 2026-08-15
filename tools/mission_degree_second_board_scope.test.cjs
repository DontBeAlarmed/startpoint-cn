"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    allFacts,
    bundledMissionContentRepository,
    character,
    createSession,
    getMissionCatalog,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

function catalogFor(targetCharacterId, source) {
    const definitions = structuredClone(bundledMissionContentRepository.table("mission_degree.json"))
    definitions[1111001][0][15] = String(targetCharacterId)
    return getMissionCatalog(repositoryWith({
        "mission_degree.json": definitions,
        "mana_board.json": {
            111001: { 2: { a: [[101]] } },
            111002: { 2: { malformed: [[true]] } },
        },
    }, source))
}

test("specific second-board derivation ignores unrelated player characters", () => {
    const catalog = catalogFor(111001, "specific-board-scope")
    const facts = allFacts({
        characters: { 111001: character(), 111002: character() },
        characterManaNodes: { 111001: [101], 111002: [1] },
    })
    const context = DegreeComputer.buildContextFromSession(
        createSession(catalog, [1111001], facts), 5, [1111001],
    )
    assert.equal(DegreeComputer.compute(1111001, context, 0), 1)
    assert.equal(context.degreeStats.secondManaBoardNodeCount, 1)
})

test("specific or aggregate requests validate every second board they use", () => {
    for (const [catalog, missionIds, label] of [
        [catalogFor(111002, "specific-board-malformed-target"), [1111001], "specific"],
        [catalogFor(111001, "aggregate-board-malformed-target"), [55000], "aggregate"],
    ]) {
        const calls = []
        assert.throws(
            () => DegreeComputer.buildContextFromSession(
                createSession(catalog, missionIds, allFacts(), calls), 5, missionIds,
            ),
            /mana_board\.json.*5:/i,
            label,
        )
        assert.deepEqual(calls, [], label)
    }
})
