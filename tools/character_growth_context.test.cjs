"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    createCharacterGrowthRequestContext,
} = require("../src/lib/character-growth/request-context")
const {
    createCharacterGrowthBatchContext,
} = require("../src/lib/character-growth/batch-context")

function stored(characterId) {
    return {
        characterId,
        exp: 100,
        stack: 2,
        overLimitStep: 1,
        evolutionLevel: 3,
        manaBoardIndex: 1,
    }
}

function createRepository(calls, overrides = {}) {
    return {
        getCharacterSync(playerId, characterId) {
            calls.core++
            return overrides.character ?? stored(characterId)
        },
        getCharactersByIdsSync(playerId, ids) {
            calls.coreBatch++
            return Object.fromEntries(ids.map(id => [String(id), stored(id)]))
        },
        getBondTokensSync() {
            calls.bond++
            return overrides.bond ?? new Map([[2, 1], [1, 2]])
        },
        getBondTokensByCharacterIdsSync(playerId, ids) {
            calls.bondBatch++
            return Object.fromEntries(ids.map(id => [String(id), new Map([[1, 2]])]))
        },
        getNormalManaNodesSync() {
            calls.nodes++
            return new Map([[101, 0]])
        },
        getNormalManaNodesByCharacterIdsSync(playerId, ids) {
            calls.nodesBatch++
            return Object.fromEntries(ids.map(id => [String(id), new Map([[id * 100, 0]])]))
        },
        getAwakeUnlocksSync() {
            calls.awake++
            return overrides.awake ?? new Map([[1, 1]])
        },
        getAwakeUnlocksByCharacterIdsSync(playerId, ids) {
            calls.awakeBatch++
            return Object.fromEntries(ids.map(id => [String(id), new Map([[1, 1]])]))
        },
        getRequiredItemsSync(playerId, ids) {
            calls.items++
            calls.itemIds.push([...ids])
            const missingItemIds = new Set(overrides.missingItemIds ?? [])
            return new Map(ids
                .filter(id => !missingItemIds.has(id))
                .map(id => [id, id * 10]))
        },
    }
}

function facts(characterId) {
    return {
        boardCount: 2,
        boardNodeIds: new Map([[1, new Set([1])], [2, new Set([2])]]),
        secondBoardAvailable: true,
    }
}

test("request context loads no section before it is called and caches each section", () => {
    const calls = { core: 0, bond: 0, nodes: 0, awake: 0, items: 0, itemIds: [] }
    const context = createCharacterGrowthRequestContext({
        playerId: 7,
        characterId: 101,
        repository: createRepository(calls),
        contentFactsLoader: facts,
        rarityLoader: () => 5,
    })

    assert.deepEqual(calls, { core: 0, bond: 0, nodes: 0, awake: 0, items: 0, itemIds: [] })
    assert.equal(context.character().characterId, 101)
    assert.equal(calls.core, 1)
    assert.equal(context.character().exp, 100)
    assert.equal(calls.core, 1)
    assert.equal(calls.bond, 0)
    assert.equal(calls.nodes, 0)
    assert.equal(calls.awake, 0)
    assert.deepEqual([...context.bondTokens()], [[2, 1], [1, 2]])
    context.bondTokens()
    context.normalManaNodes()
    context.normalManaNodes()
    context.awakeUnlocks()
    context.awakeUnlocks()
    assert.equal(calls.bond, 1)
    assert.equal(calls.nodes, 1)
    assert.equal(calls.awake, 1)
    assert.deepEqual(context.requiredItems([4, 5]), new Map([[4, 40], [5, 50]]))
    assert.deepEqual(context.requiredItems([4, 5]), new Map([[4, 40], [5, 50]]))
    assert.equal(calls.items, 1)
    assert.deepEqual(calls.itemIds, [[4, 5]])
    assert.deepEqual(context.contentFacts(), facts(101))
})

test("request context rejects invalid raw section values before exposing them", () => {
    const calls = { core: 0, bond: 0, nodes: 0, awake: 0, items: 0, itemIds: [] }
    const repository = createRepository(calls, {
        bond: new Map([[1, 3]]),
        awake: new Map([[1, 0]]),
    })
    const context = createCharacterGrowthRequestContext({
        playerId: 7,
        characterId: 101,
        repository,
        rarityLoader: () => 5,
    })
    assert.throws(() => context.bondTokens(), error => error.code === "INVALID_GROWTH_STATE")
    assert.throws(() => context.awakeUnlocks(), error => error.code === "INVALID_GROWTH_STATE")
})

test("required item section rejects a later disjoint ID set instead of issuing a second read", () => {
    const calls = { core: 0, bond: 0, nodes: 0, awake: 0, items: 0, itemIds: [] }
    const context = createCharacterGrowthRequestContext({
        playerId: 7,
        characterId: 101,
        repository: createRepository(calls),
        rarityLoader: () => 5,
    })
    assert.deepEqual(context.requiredItems([4]), new Map([[4, 40]]))
    assert.throws(
        () => context.requiredItems([5]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(calls.items, 1)
    assert.deepEqual(calls.itemIds, [[4]])
})

test("batch context reads each requested table once and returns character buckets", () => {
    const calls = {
        core: 0, coreBatch: 0, bondBatch: 0, nodesBatch: 0, awakeBatch: 0,
        items: 0, itemIds: [],
    }
    const context = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [202, 101, 202],
        repository: createRepository(calls),
        contentFactsLoader: facts,
        rarityLoader: () => 5,
    })

    assert.deepEqual([...context.characters()].map(([id]) => id), [101, 202])
    assert.equal(context.character(101).characterId, 101)
    assert.equal(context.character(202).characterId, 202)
    context.bondTokens(101)
    context.bondTokens(202)
    context.normalManaNodes(101)
    context.normalManaNodes(202)
    context.awakeUnlocks(101)
    context.awakeUnlocks(202)
    assert.deepEqual([...context.normalManaNodes(202)], [[20200, 0]])
    assert.equal(calls.coreBatch, 1)
    assert.equal(calls.bondBatch, 1)
    assert.equal(calls.nodesBatch, 1)
    assert.equal(calls.awakeBatch, 1)
    assert.equal(calls.core, 0)
})

test("batch required item section also rejects a later disjoint ID set", () => {
    const calls = {
        core: 0, coreBatch: 0, bondBatch: 0, nodesBatch: 0, awakeBatch: 0,
        items: 0, itemIds: [],
    }
    const context = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [101, 202],
        repository: createRepository(calls),
        rarityLoader: () => 5,
    })
    assert.deepEqual(context.requiredItems([4]), new Map([[4, 40]]))
    assert.throws(
        () => context.requiredItems([5]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(calls.items, 1)
    assert.deepEqual(calls.itemIds, [[4]])
})

test("request context caches missing items as zero for the same set and its subsets", () => {
    const calls = { core: 0, bond: 0, nodes: 0, awake: 0, items: 0, itemIds: [] }
    const context = createCharacterGrowthRequestContext({
        playerId: 7,
        characterId: 101,
        repository: createRepository(calls, { missingItemIds: [999] }),
        rarityLoader: () => 5,
    })
    assert.deepEqual(context.requiredItems([999]), new Map([[999, 0]]))
    assert.deepEqual(context.requiredItems([999]), new Map([[999, 0]]))
    assert.deepEqual(context.requiredItems([]), new Map())
    assert.throws(
        () => context.requiredItems([999, 1000]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(calls.items, 1)
    assert.deepEqual(calls.itemIds, [[999]])
})

test("batch context caches missing items as zero for the same set and its subsets", () => {
    const calls = {
        core: 0, coreBatch: 0, bondBatch: 0, nodesBatch: 0, awakeBatch: 0,
        items: 0, itemIds: [],
    }
    const context = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [101, 202],
        repository: createRepository(calls, { missingItemIds: [999] }),
        rarityLoader: () => 5,
    })
    assert.deepEqual(context.requiredItems([999]), new Map([[999, 0]]))
    assert.deepEqual(context.requiredItems([999]), new Map([[999, 0]]))
    assert.deepEqual(context.requiredItems([]), new Map())
    assert.throws(
        () => context.requiredItems([999, 1000]),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(calls.items, 1)
    assert.deepEqual(calls.itemIds, [[999]])
})

test("character response reads and Growth entries keep bond tokens ordered by board identity", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/data/domains/character.ts"),
        "utf8",
    )
    const growthEntry = source.slice(
        source.indexOf("export function getPlayerCharacterBondTokensByIdsSync"),
        source.indexOf("export function getPlayerCharacterBondTokensSync"),
    )
    assert.match(growthEntry, /ORDER BY character_id, mana_board_index/)

    assert.match(source.slice(
        source.indexOf("export function getPlayerCharacterSync"),
        source.indexOf("export function getPlayerCharactersSync"),
    ), /ORDER BY mana_board_index/)
    assert.match(source.slice(
        source.indexOf("export function getPlayerCharactersSync"),
        source.indexOf("export function getPlayerCharactersByIdsSync"),
    ), /ORDER BY character_id, mana_board_index/)
    const byIdsStart = source.indexOf("export function getPlayerCharactersByIdsSync")
    const byIdsEnd = source.indexOf("\nexport function ", byIdsStart + 1)
    assert.match(source.slice(byIdsStart, byIdsEnd === -1 ? source.length : byIdsEnd), /ORDER BY character_id, mana_board_index/)
})
