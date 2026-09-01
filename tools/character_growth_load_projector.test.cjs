"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    createCharacterGrowthBatchContext,
} = require("../src/lib/character-growth/batch-context")
const {
    projectCharacterGrowthLoad,
} = require("../src/lib/character-growth/load-projector")

function stored(characterId) {
    return {
        characterId,
        exp: characterId * 10,
        stack: characterId,
        protection: false,
        overLimitStep: 0,
        evolutionLevel: 0,
        manaBoardIndex: 1,
    }
}

function metadata(characterId) {
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: new Date("2024-08-14T12:00:00.000Z"),
        updateTime: new Date("2024-08-14T12:01:00.000Z"),
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [],
        illustrationSettings: [characterId, 0, 0, 0, 0, 0],
    }
}

function runProjection(characterIds) {
    const calls = { core: 0, bond: 0, nodes: 0, awake: 0 }
    const singles = () => { throw new Error("single-character repository loader must not run") }
    const repository = {
        getCharacterSync: singles,
        getBondTokensSync: singles,
        getNormalManaNodesSync: singles,
        getAwakeUnlocksSync: singles,
        getRequiredItemsSync: singles,
        getCharactersByIdsSync(_playerId, ids) {
            calls.core++
            return Object.fromEntries(ids.map(id => [String(id), stored(id)]))
        },
        getBondTokensByCharacterIdsSync(_playerId, ids) {
            calls.bond++
            return Object.fromEntries(ids.map(id => [String(id), new Map([[2, 0], [1, 2]])]))
        },
        getNormalManaNodesByCharacterIdsSync(_playerId, ids) {
            calls.nodes++
            return Object.fromEntries(ids.map(id => [String(id), new Map([[id * 100 + 1, 0]])]))
        },
        getAwakeUnlocksByCharacterIdsSync(_playerId, ids) {
            calls.awake++
            return Object.fromEntries(ids.map(id => [
                String(id),
                id === 1 ? new Map([[1, 1]]) : new Map(),
            ]))
        },
    }
    const batch = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds,
        repository,
        rarityLoader: () => 4,
        contentFactsLoader: characterId => ({
            rarity: 4,
            boardCount: 2,
            boardNodeIds: new Map([
                [1, new Set([characterId * 100 + 1])],
                [2, new Set([characterId * 100 + 2])],
            ]),
            secondBoardAvailable: true,
        }),
    })
    const characters = Object.fromEntries(characterIds.map(id => [String(id), metadata(id)]))
    const projection = projectCharacterGrowthLoad({
        batch,
        characters,
        visibleManaBoardIndexes: new Map(characterIds.map(id => [id, 1])),
    })
    return { calls, projection }
}

test("load projector uses one batch read per Growth section for one or many characters", () => {
    const one = runProjection([1])
    const many = runProjection([2, 1])
    assert.deepEqual(one.calls, { core: 1, bond: 1, nodes: 1, awake: 1 })
    assert.deepEqual(many.calls, { core: 1, bond: 1, nodes: 1, awake: 1 })

    assert.deepEqual(Object.keys(many.projection.userCharacterList), ["1", "2"])
    assert.equal("character_id" in many.projection.userCharacterList["1"], false)
    assert.deepEqual(many.projection.userCharacterList["1"].bond_token_list, [
        { mana_board_index: 1, status: 2 },
        { mana_board_index: 2, status: 0 },
    ])
    assert.deepEqual(many.projection.userCharacterList["1"].mana_board_awake, { 1: 1 })
    assert.equal("mana_board_awake" in many.projection.userCharacterList["2"], false)
    assert.deepEqual(many.projection.userCharacterManaNodeList, {
        1: [{ multiplied_id: 101, awake_level: 0 }],
        2: [{ multiplied_id: 201, awake_level: 0 }],
    })
})

test("load projector is pure and rejects mismatched protocol metadata", () => {
    const calls = { core: 0 }
    const batch = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [1],
        repository: {
            getCharactersByIdsSync() { calls.core++; return { 1: stored(1) } },
        },
        rarityLoader: () => 4,
        contentFactsLoader: () => ({
            rarity: 4,
            boardCount: 1,
            boardNodeIds: new Map([[1, new Set([101])]]),
            secondBoardAvailable: false,
        }),
    })
    assert.throws(
        () => projectCharacterGrowthLoad({ batch, characters: {} }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(calls.core, 1)

    const source = fs.readFileSync(
        path.join(__dirname, "../src/lib/character-growth/load-projector.ts"),
        "utf8",
    )
    assert.doesNotMatch(source, /data\/db|data\/domains/)
})

test("load projector rejects one Content-invalid persisted terminal state before projection", () => {
    let contentCalls = 0
    const batch = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [1],
        repository: {},
        rarityLoader: () => 4,
        storedCharactersSnapshot: { 1: stored(1) },
        bondTokenSnapshots: { 1: new Map([[1, 0], [2, 1]]) },
        normalManaNodeSnapshots: { 1: new Map([[101, 2], [201, 0]]) },
        awakeUnlockSnapshots: { 1: new Map([[1, 1]]) },
        contentFactsLoader: () => {
            contentCalls++
            return {
                rarity: 4,
                boardCount: 2,
                boardNodeIds: new Map([[1, new Set([101])], [2, new Set([201])]]),
                secondBoardAvailable: true,
            }
        },
    })
    assert.throws(
        () => projectCharacterGrowthLoad({ batch, characters: { 1: metadata(1) } }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(contentCalls, 1)
})

test("the real load adapter can project its already-batched post-recovery snapshots without rereads", () => {
    const repository = new Proxy({}, {
        get() { return () => { throw new Error("preloaded load projection must not read the repository") } },
    })
    const batch = createCharacterGrowthBatchContext({
        playerId: 7,
        characterIds: [1],
        repository,
        rarityLoader: () => 4,
        storedCharactersSnapshot: { 1: stored(1) },
        bondTokenSnapshots: { 1: new Map([[1, 2]]) },
        normalManaNodeSnapshots: { 1: new Map([[101, 0]]) },
        awakeUnlockSnapshots: { 1: new Map([[1, 1]]) },
        contentFactsLoader: () => ({
            rarity: 4,
            boardCount: 1,
            boardNodeIds: new Map([[1, new Set([101])]]),
            secondBoardAvailable: false,
        }),
    })
    const projection = projectCharacterGrowthLoad({
        batch,
        characters: { 1: metadata(1) },
    })
    assert.deepEqual(projection.userCharacterManaNodeList, {
        1: [{ multiplied_id: 101, awake_level: 0 }],
    })
})
