"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const test = require("node:test")

const { createCharacterGrowthRequestContext } = require("../../src/lib/character-growth/request-context")
const { createCharacterGrowthBatchContext } = require("../../src/lib/character-growth/batch-context")

const TABLES = Object.freeze({
    core: "players_characters",
    bond: "players_characters_bond_tokens",
    nodes: "players_characters_mana_nodes",
    awake: "players_character_awake_unlocks",
    items: "players_items",
})

function createCounters() {
    return {
        reads: 0,
        writes: 0,
        loaders: { core: 0, bond: 0, nodes: 0, awake: 0, items: 0 },
        tables: Object.fromEntries(Object.values(TABLES).map(table => [
            table,
            { reads: 0, writes: 0, statements: 0 },
        ])),
    }
}

function observe(counters, section) {
    const table = TABLES[section]
    counters.reads++
    counters.loaders[section]++
    counters.tables[table].reads++
    counters.tables[table].statements++
}

function stored(characterId) {
    return {
        characterId,
        exp: 100,
        stack: 1,
        overLimitStep: 0,
        evolutionLevel: 0,
        manaBoardIndex: 1,
    }
}

function repositoryFor(counters) {
    return {
        getCharacterSync(_playerId, characterId) {
            observe(counters, "core")
            return stored(characterId)
        },
        getCharactersByIdsSync(_playerId, ids) {
            observe(counters, "core")
            return Object.fromEntries(ids.map(id => [String(id), stored(id)]))
        },
        getBondTokensSync() {
            observe(counters, "bond")
            return new Map([[1, 0]])
        },
        getBondTokensByCharacterIdsSync(_playerId, ids) {
            observe(counters, "bond")
            return Object.fromEntries(ids.map(id => [String(id), new Map([[1, 0]])]))
        },
        getNormalManaNodesSync() {
            observe(counters, "nodes")
            return new Map()
        },
        getNormalManaNodesByCharacterIdsSync(_playerId, ids) {
            observe(counters, "nodes")
            return Object.fromEntries(ids.map(id => [String(id), new Map()]))
        },
        getAwakeUnlocksSync() {
            observe(counters, "awake")
            return new Map()
        },
        getAwakeUnlocksByCharacterIdsSync(_playerId, ids) {
            observe(counters, "awake")
            return Object.fromEntries(ids.map(id => [String(id), new Map()]))
        },
        getRequiredItemsSync(_playerId, ids) {
            observe(counters, "items")
            return new Map(ids.map(id => [id, 10]))
        },
    }
}

function canonicalReport(scenarios) {
    const report = { version: 1, scenarios }
    for (const scenario of Object.values(report.scenarios)) {
        scenario.behaviorSha256 = crypto.createHash("sha256")
            .update(JSON.stringify(scenario.behavior))
            .digest("hex")
    }
    return report
}

function scenario(counters, behavior) {
    return {
        sqlReads: counters.reads,
        sqlWrites: counters.writes,
        loaders: counters.loaders,
        sqlByTable: counters.tables,
        behavior,
    }
}

test("character growth context admission proves lazy and cached section reads", () => {
    const counters = createCounters()
    const context = createCharacterGrowthRequestContext({
        playerId: 1,
        characterId: 101,
        repository: repositoryFor(counters),
        rarityLoader: () => 5,
        contentFactsLoader: () => ({
            boardCount: 1,
            boardNodeIds: new Map([[1, new Set()]]),
            secondBoardAvailable: false,
        }),
    })
    assert.equal(counters.reads, 0)
    context.character()
    assert.equal(counters.loaders.bond, 0)
    context.bondTokens()
    context.bondTokens()
    context.normalManaNodes()
    context.normalManaNodes()
    context.awakeUnlocks()
    context.awakeUnlocks()
    context.requiredItems([1, 2])
    context.requiredItems([1, 2])

    const report = canonicalReport({ cached: scenario(counters, {
        character: true,
        sections: ["bond", "nodes", "awake", "items"],
    }) })
    assert.equal(report.scenarios.cached.sqlReads, 5)
    assert.equal(report.scenarios.cached.sqlWrites, 0)
    assert.equal(report.scenarios.cached.loaders.bond, 1)
    assert.equal(report.scenarios.cached.loaders.nodes, 1)
    assert.equal(report.scenarios.cached.loaders.awake, 1)
    assert.equal(report.scenarios.cached.loaders.items, 1)
    assert.match(report.scenarios.cached.behaviorSha256, /^[a-f0-9]{64}$/)
    assert.equal(report.scenarios.cached.sqlByTable.players_equipment, undefined)
})

test("single-character context remains targeted and batch reads stay constant as character count grows", () => {
    const oneCounters = createCounters()
    const one = createCharacterGrowthBatchContext({
        playerId: 1,
        characterIds: [101],
        repository: repositoryFor(oneCounters),
        rarityLoader: () => 5,
    })
    one.characters()
    one.bondTokens(101)
    one.normalManaNodes(101)
    one.awakeUnlocks(101)
    one.requiredItems([1, 2])

    const manyCounters = createCounters()
    const manyIds = Array.from({ length: 20 }, (_unused, index) => index + 101)
    const many = createCharacterGrowthBatchContext({
        playerId: 1,
        characterIds: manyIds,
        repository: repositoryFor(manyCounters),
        rarityLoader: () => 5,
    })
    many.characters()
    for (const characterId of manyIds) {
        many.bondTokens(characterId)
        many.normalManaNodes(characterId)
        many.awakeUnlocks(characterId)
    }
    many.requiredItems([1, 2])

    assert.equal(oneCounters.reads, 5)
    assert.equal(manyCounters.reads, 5)
    assert.deepEqual(
        Object.fromEntries(Object.entries(manyCounters.loaders)),
        Object.fromEntries(Object.entries(oneCounters.loaders)),
    )
    assert.equal(manyCounters.tables.players_characters.statements, 1)
    assert.equal(manyCounters.tables.players_characters_bond_tokens.statements, 1)
    assert.equal(manyCounters.tables.players_characters_mana_nodes.statements, 1)
    assert.equal(manyCounters.tables.players_character_awake_unlocks.statements, 1)
    assert.equal(manyCounters.tables.players_items.statements, 1)
})

test("admission report contains stable read/write and behavior-hash fields", () => {
    const counters = createCounters()
    const report = canonicalReport({ untouched: scenario(counters, { sql: 0, writes: 0 }) })
    assert.deepEqual(Object.keys(report), ["version", "scenarios"])
    assert.deepEqual(Object.keys(report.scenarios.untouched), [
        "sqlReads", "sqlWrites", "loaders", "sqlByTable", "behavior", "behaviorSha256",
    ])
    console.log(JSON.stringify(report))
})

