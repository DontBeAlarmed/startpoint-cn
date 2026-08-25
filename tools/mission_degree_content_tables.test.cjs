"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    allFacts,
    bundledMissionContentRepository,
    buildDegreeRuleCatalog,
    character,
    createSession,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

test("companion-only Degree rules do not read unrelated malformed auxiliary tables", () => {
    const reads = []
    const base = repositoryWith({}, "companion-only-base")
    const repository = {
        ...base,
        table(tableName) {
            reads.push(tableName)
            if (tableName === "mana_board.json") throw new Error("unrelated malformed mana board was read")
            return base.table(tableName)
        },
    }
    const catalog = getMissionCatalog(repository)
    getMissionFactRequirementRegistry(catalog)
    reads.length = 0
    const session = createSession(catalog, [2000], allFacts({
        characters: { 111001: character() },
    }))
    const context = DegreeComputer.buildContextFromSession(session, 5, [2000])
    assert.equal(DegreeComputer.compute(2000, context, 0), 1)
    assert.deepEqual(reads, [])
})

test("second-board Degree rules reject malformed Content before any fact loader", () => {
    const catalog = getMissionCatalog(repositoryWith({
        "mana_board.json": { 111001: { 2: { broken: [["not-a-node-id"]] } } },
    }, "malformed-second-board"))
    const calls = []
    const session = createSession(catalog, [1111001], allFacts(), calls)
    assert.throws(
        () => DegreeComputer.buildContextFromSession(session, 5, [1111001]),
        /mana_board\.json.*5:1111001|5:1111001.*mana_board\.json/i,
    )
    assert.deepEqual(calls, [])
})

test("aggregate second-board rules do not hide a missing specific character row", () => {
    const catalog = getMissionCatalog(repositoryWith({
        "mana_board.json": { 111002: { 2: { a: [[101]] } } },
    }, "missing-specific-second-board"))
    const calls = []
    const session = createSession(catalog, [55000, 1111001], allFacts(), calls)
    assert.throws(
        () => DegreeComputer.buildContextFromSession(session, 5, [55000, 1111001]),
        error => error.message.includes("mana_board.json") && error.message.includes("5:1111001"),
    )
    assert.deepEqual(calls, [])
})

test("required Degree table repository failures propagate with table and mission context", () => {
    const base = repositoryWith({}, "required-table-failure-base")
    const repository = {
        ...base,
        table(tableName) {
            if (tableName === "mana_board.json") throw new Error("repository exploded")
            return base.table(tableName)
        },
    }
    const catalog = getMissionCatalog(repository)
    const calls = []
    const session = createSession(catalog, [1111001], allFacts(), calls)
    assert.throws(
        () => DegreeComputer.buildContextFromSession(session, 5, [1111001]),
        error => /mana_board\.json/.test(error.message)
            && /5:1111001/.test(error.message)
            && /repository exploded/.test(error.message),
    )
    assert.deepEqual(calls, [])
})

test("Degree validates every requested auxiliary table family before fact loading", () => {
    const cases = [
        [3010, "character.json", { 111001: { rarity: "bad" } }],
        [9000, "main_quest.json", {}],
        [11010, "boss_battle_quest.json", { 1003004: { enemyLevel: "bad" } }],
        [57010, "expert_single_event_quest.json", { 1001: null }],
        [46000, "treasure_shop.json", { 1: null }],
        [43000, "equipment_dissolve.json", { 1: { max_level: "bad" } }],
    ]
    for (const [missionId, tableName, malformed] of cases) {
        const catalog = getMissionCatalog(repositoryWith({
            [tableName]: malformed,
        }, `malformed-${missionId}`))
        const calls = []
        const session = createSession(catalog, [missionId], allFacts(), calls)
        assert.throws(
            () => DegreeComputer.buildContextFromSession(session, 5, [missionId]),
            error => error.message.includes(tableName) && error.message.includes(`5:${missionId}`),
        )
        assert.deepEqual(calls, [])
    }
})

test("Degree Content rejects coercive integer fields before fact loading", () => {
    const probes = [true, [1], " 42 ", "1e3"]
    const cases = probes.flatMap((probe, index) => [
        [3010, "character.json", { 111001: { rarity: probe } }, `rarity-${index}`],
        [1111001, "mana_board.json", { 111001: { 2: { a: [[probe]] } } }, `node-${index}`],
        [11010, "boss_battle_quest.json", { 1003004: { enemyLevel: probe } }, `level-${index}`],
        [43000, "equipment_dissolve.json", { 1: { max_level: probe } }, `equipment-${index}`],
    ])
    cases.push([46000, "treasure_shop.json", { " 42 ": {} }, "row-space"])
    cases.push([46000, "treasure_shop.json", { "1e3": {} }, "row-scientific"])

    for (const [missionId, tableName, malformed, source] of cases) {
        const catalog = getMissionCatalog(repositoryWith({ [tableName]: malformed }, source))
        const calls = []
        assert.throws(
            () => DegreeComputer.buildContextFromSession(
                createSession(catalog, [missionId], allFacts(), calls), 5, [missionId],
            ),
            error => error.message.includes(tableName) && error.message.includes(`5:${missionId}`),
            `${tableName}:${source}`,
        )
        assert.deepEqual(calls, [], `${tableName}:${source}`)
    }
})

test("Degree rules never advance from coercive mission selectors", () => {
    const probes = [true, [1], " 42 ", "1e3"]
    for (const [index, probe] of probes.entries()) {
        for (const [missionId, column, overrides, facts] of [
            [1111001, 15, {
                "mana_board.json": { 1: { 2: { a: [[101]] } }, 42: { 2: { a: [[101]] } }, 1000: { 2: { a: [[101]] } } },
            }, allFacts({
                characters: { 1: character(), 42: character(), 1000: character() },
                characterManaNodes: { 1: [101], 42: [101], 1000: [101] },
            })],
            [57010, 9, {
                "expert_single_event_quest.json": { 1001: {}, 42001: {}, 1000001: {} },
            }, allFacts({
                questProgress: { 21: [
                    { questId: 1001, finished: true },
                    { questId: 42001, finished: true },
                    { questId: 1000001, finished: true },
                ] },
            })],
            [70000, 13, {}, allFacts({ collectedItems: { 1: 9, 42: 9, 1000: 9 } })],
        ]) {
            const definitions = structuredClone(
                bundledMissionContentRepository.table("mission_degree.json"),
            )
            definitions[missionId][0][column] = probe
            const catalog = getMissionCatalog(repositoryWith({
                "mission_degree.json": definitions,
                ...overrides,
            }, `selector-${missionId}-${index}`))
            let context
            try {
                context = DegreeComputer.buildContextFromSession(
                    createSession(catalog, [missionId], facts), 5, [missionId],
                )
            } catch (error) {
                assert.match(error.message, /Degree|mission|Content|selector/i)
                continue
            }
            assert.equal(DegreeComputer.compute(missionId, context, 0), 0, `${missionId}:${index}`)
        }
    }
})

test("Degree Content wraps unsupported immutable values with table and mission context", () => {
    const row = {}
    Object.defineProperty(row, "rarity", { get: () => 5, enumerable: true })
    const catalog = getMissionCatalog(repositoryWith({
        "character.json": { 111001: row },
    }, "character-accessor"))
    const calls = []
    assert.throws(
        () => DegreeComputer.buildContextFromSession(
            createSession(catalog, [3010], allFacts(), calls), 5, [3010],
        ),
        error => error.message.includes("character.json")
            && error.message.includes("5:3010")
            && error.message.includes("$[111001].rarity"),
    )
    assert.deepEqual(calls, [])
})

test("Degree Content table source remains the supplied Catalog", () => {
    const definitions = structuredClone(bundledMissionContentRepository.table("mission_degree.json"))
    definitions[1111001][0][15] = "999001"
    const catalog = getMissionCatalog(repositoryWith({
        "mission_degree.json": definitions,
        "mana_board.json": { 999001: { 2: { a: [[101]], b: [[102]] } } },
    }, "custom-mana-board"))
    const facts = allFacts({
        characters: { 999001: character() },
        characterManaNodes: { 999001: [101, 102] },
    })
    const context = DegreeComputer.buildContextFromSession(
        createSession(catalog, [1111001], facts), 5, [1111001],
    )
    assert.equal(DegreeComputer.compute(1111001, context, 0), 1)
})

test("boss Degree rules use the mission description to disambiguate same-level quests", () => {
    const catalog = getMissionCatalog(repositoryWith({
        "boss_battle_quest.json": {
            1001001: { enemyLevel: 10, name: "" },
            1001002: { enemyLevel: 80, name: "技伤不死王 ::quest_rank::" },
            1001003: { enemyLevel: 80, name: "维·索拉斯 ::quest_rank::" },
            1001004: { enemyLevel: 80, name: "能力不死王 ::quest_rank::" },
        },
    }, "boss-degree-name-selector"))

    const rules = buildDegreeRuleCatalog(catalog, [70009]).rules
    assert.equal(rules.get(70009).questId, 1001003)
})
