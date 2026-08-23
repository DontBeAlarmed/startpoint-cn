"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const test = require("node:test")

const {
    MissionFactLoaderRegistry,
    createProductionMissionFactLoaderRegistry,
} = require("../src/lib/mission")
const { createSession } = require("./helpers/mission-evaluation-session-fixture.cjs")

test("rejects Promise loaders and caches the synchronous contract failure", () => {
    let calls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        calls++
        return Promise.resolve({ id: 77 })
    })
    const session = createSession([{ kind: "player" }], loaders)

    assert.throws(() => session.getFact({ kind: "player" }), /must be synchronous/i)
    assert.throws(() => session.getFact({ kind: "player" }), /must be synchronous/i)
    assert.equal(calls, 1)
})

test("rejects a non-Promise thenable synchronously", () => {
    let calls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        calls++
        return { then(resolve) { resolve({ id: 77 }) } }
    })
    const session = createSession([{ kind: "player" }], loaders)

    assert.throws(() => session.getFact({ kind: "player" }), /must be synchronous/i)
    assert.equal(calls, 1)
})

test("a rejected Promise loader is consumed without an unhandled rejection", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--unhandled-rejections=strict",
            path.join(__dirname, "helpers/mission-evaluation-rejected-promise-worker.cjs"),
        ],
        { encoding: "utf8" },
    )

    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.match(result.stdout, /rejected Promise consumed/)
})

test("production loaders dispatch exact domain calls and preserve values", () => {
    const calls = []
    const values = {
        player: { id: 77 },
        quests: { 1: [{ questId: 10 }], 4: [{ questId: 40 }] },
        counters: { singlePlayCount: 3 },
        shop: { 1001: 4, 1002: 7 },
        daily: { questClears: 1 },
        weekly: { questClears: 2 },
        pass: { questClears: 3 },
    }
    const loaders = createProductionMissionFactLoaderRegistry({
        getPlayerSync(playerId) {
            calls.push(["player", playerId])
            return values.player
        },
        getPlayerQuestProgressSync(playerId, sections) {
            calls.push(["quests", playerId, sections])
            return values.quests
        },
        getMissionBattleCountersSync(playerId) {
            calls.push(["counters", playerId])
            return values.counters
        },
        getPlayerShopPurchasesMapSync(playerId, shopType) {
            calls.push(["shop", playerId, shopType])
            return values.shop
        },
        getSnapshot(playerId, periodType) {
            calls.push(["snapshot", playerId, periodType])
            if (periodType === "daily") return values.daily
            if (periodType === "weekly") return values.weekly
            return values.pass
        },
        getPassWeekSnapshotType(eventId) {
            calls.push(["passType", eventId])
            return `pass-week:${eventId}`
        },
    })
    const session = createSession([
        { kind: "player" },
        { kind: "questProgress", sections: [4, 1] },
        { kind: "missionBattleCounters" },
        { kind: "shopPurchases", shopType: 2 },
        { kind: "periodicSnapshot", snapshotKind: "daily" },
        { kind: "periodicSnapshot", snapshotKind: "weekly" },
        { kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 9 },
    ], loaders)

    assert.strictEqual(session.getFact({ kind: "player" }), values.player)
    assert.strictEqual(
        session.getFact({ kind: "questProgress", sections: [1] }),
        values.quests,
    )
    assert.strictEqual(session.getFact({ kind: "missionBattleCounters" }), values.counters)
    assert.strictEqual(
        session.getFact({ kind: "shopPurchases", shopType: 2 }),
        values.shop,
    )
    assert.strictEqual(
        session.getFact({ kind: "periodicSnapshot", snapshotKind: "daily" }),
        values.daily,
    )
    assert.strictEqual(
        session.getFact({ kind: "periodicSnapshot", snapshotKind: "weekly" }),
        values.weekly,
    )
    assert.strictEqual(
        session.getFact({ kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 9 }),
        values.pass,
    )
    assert.deepEqual(calls, [
        ["player", 77],
        ["quests", 77, [1, 4]],
        ["counters", 77],
        ["shop", 77, 2],
        ["snapshot", 77, "daily"],
        ["snapshot", 77, "weekly"],
        ["passType", 9],
        ["snapshot", 77, "pass-week:9"],
    ])
})

test("production shop purchase loader stays lazy and calls its domain once per planned key", () => {
    const calls = []
    const value = Object.freeze({ 501: 3 })
    const loaders = createProductionMissionFactLoaderRegistry({
        getPlayerShopPurchasesMapSync(playerId, shopType) {
            calls.push([playerId, shopType])
            return value
        },
    })
    const session = createSession([
        { kind: "shopPurchases", shopType: 5 },
    ], loaders)

    assert.equal(calls.length, 0)
    assert.strictEqual(session.getFact({ kind: "shopPurchases", shopType: 5 }), value)
    assert.strictEqual(session.getFact({ kind: "shopPurchases", shopType: 5 }), value)
    assert.deepEqual(calls, [[77, 5]])
})

test("production player loader fails explicitly when the player is missing", () => {
    const domains = {
        getPlayerSync: () => null,
        getPlayerQuestProgressSync: () => ({}),
        getMissionBattleCountersSync: () => ({}),
        getSnapshot: () => null,
        getPassWeekSnapshotType: eventId => `pass-week:${eventId}`,
    }
    const session = createSession(
        [{ kind: "player" }],
        createProductionMissionFactLoaderRegistry(domains),
        { playerId: 404 },
    )

    assert.throws(() => session.getFact({ kind: "player" }), /player 404.*not found/i)
})

test("production Regular loaders dispatch singleton and collected selection domains once", () => {
    const calls = []
    const values = {
        characters: { 100001: { exp: 10 } },
        manaNodes: { 100001: [1, 2] },
        equipment: { 200001: { level: 5 } },
        selected: { 11: 3, 33: 9 },
        all: { 11: 3, 22: 7, 33: 9 },
        degree: { feverCount: 4 },
    }
    const domains = {
        getPlayerCharactersSync(playerId) {
            calls.push(["characters", playerId])
            return values.characters
        },
        getPlayerCharactersManaNodesSync(playerId) {
            calls.push(["manaNodes", playerId])
            return values.manaNodes
        },
        getPlayerEquipmentListSync(playerId) {
            calls.push(["equipment", playerId])
            return values.equipment
        },
        getPlayerCollectedItemTotalsByIdsSync(playerId, itemIds) {
            calls.push(["collectedSelected", playerId, itemIds])
            return values.selected
        },
        getPlayerCollectedItemTotalsSync(playerId) {
            calls.push(["collectedAll", playerId])
            return values.all
        },
        getDegreeBattleStatsSync(playerId) {
            calls.push(["degree", playerId])
            return values.degree
        },
    }
    const loaders = createProductionMissionFactLoaderRegistry(domains)
    const selectedSession = createSession([
        { kind: "characters" },
        { kind: "characterManaNodes" },
        { kind: "equipment" },
        { kind: "collectedItems", itemIds: [33, 11] },
        { kind: "degreeBattleStats" },
    ], loaders)

    assert.strictEqual(selectedSession.getFact({ kind: "characters" }), values.characters)
    assert.strictEqual(
        selectedSession.getFact({ kind: "characterManaNodes" }),
        values.manaNodes,
    )
    assert.strictEqual(selectedSession.getFact({ kind: "equipment" }), values.equipment)
    assert.strictEqual(
        selectedSession.getFact({ kind: "collectedItems", itemIds: [11] }),
        values.selected,
    )
    assert.strictEqual(selectedSession.getFact({ kind: "degreeBattleStats" }), values.degree)

    const allSession = createSession(
        [{ kind: "collectedItems", itemIds: "all" }],
        loaders,
    )
    assert.strictEqual(
        allSession.getFact({ kind: "collectedItems", itemIds: [22] }),
        values.all,
    )
    assert.deepEqual(calls, [
        ["characters", 77],
        ["manaNodes", 77],
        ["equipment", 77],
        ["collectedSelected", 77, [11, 33]],
        ["degree", 77],
        ["collectedAll", 77],
    ])
})

test("production Event loaders keep inventory, party, and dependency progress typed and scoped", () => {
    const calls = []
    const values = {
        items: Object.freeze({ 50001: 2 }),
        partyGroups: Object.freeze({ 1: { list: {} } }),
        missionProgress: new Map([[1448, 1], [1454, 6]]),
    }
    const loaders = createProductionMissionFactLoaderRegistry({
        getPlayerItemsSync(playerId) {
            calls.push(["items", playerId])
            return values.items
        },
        getPlayerPartyGroupListSync(playerId, category) {
            calls.push(["partyGroups", playerId, category])
            return values.partyGroups
        },
        getPlayerCategoryMissionProgressByIdsSync(playerId, category, missionIds) {
            calls.push(["categoryMissionProgress", playerId, category, missionIds])
            return values.missionProgress
        },
    })
    const session = createSession([
        { kind: "items" },
        { kind: "partyGroups", category: 1 },
        { kind: "categoryMissionProgress", category: 3, missionIds: [1454, 1448] },
    ], loaders)

    assert.strictEqual(session.getFact({ kind: "items" }), values.items)
    assert.strictEqual(
        session.getFact({ kind: "partyGroups", category: 1 }),
        values.partyGroups,
    )
    assert.strictEqual(
        session.getFact({
            kind: "categoryMissionProgress",
            category: 3,
            missionIds: [1448],
        }),
        values.missionProgress,
    )
    assert.deepEqual(calls, [
        ["items", 77],
        ["partyGroups", 77, 1],
        ["categoryMissionProgress", 77, 3, [1448, 1454]],
    ])
})

test("settlement category progress seed stays typed and filters to the Session selection", () => {
    const seeded = new Map([[3, Object.freeze({
        1448: { progress: 1, stages: [] },
        1454: { progress: 6, stages: { 1: true } },
        9999: { progress: 99, stages: [] },
    })]])
    const loaders = createProductionMissionFactLoaderRegistry({
        getPlayerCategoryMissionProgressByIdsSync() {
            throw new Error("seeded category progress must not query the database")
        },
    }, { categoryMissions: seeded })
    const session = createSession([{
        kind: "categoryMissionProgress",
        category: 3,
        missionIds: [1454, 1448],
    }], loaders)

    assert.deepEqual([...session.getFact({
        kind: "categoryMissionProgress",
        category: 3,
        missionIds: [1448],
    })], [[1448, 1], [1454, 6]])
    assert.throws(() => session.getFact({
        kind: "categoryMissionProgress",
        category: 3,
        missionIds: [9999],
    }), /outside declared missionIds selection/)
})

test("production Awake fact seeds bypass full character and counter readers", () => {
    const seededCharacters = Object.freeze({ 341005: Object.freeze({ exp: 123 }) })
    const seededClears = Object.freeze({
        341005: Object.freeze({
            clear_count: 5,
            multi_count: 2,
            leader_clear_count: 3,
            leader_multi_count: 1,
            leader_power_flip_count: 0,
        }),
    })
    const seededCoClears = Object.freeze([
        Object.freeze({ char_id_a: 341005, char_id_b: 311002, co_clear_count: 4 }),
    ])
    const loaders = createProductionMissionFactLoaderRegistry({
        getPlayerCharactersSync() {
            throw new Error("seeded characters must not query the database")
        },
        getPlayerCharacterClearsSync() {
            throw new Error("seeded character clears must not query the database")
        },
        getPlayerPartyCoClearCountersSync() {
            throw new Error("seeded party co-clears must not query the database")
        },
    }, {
        characters: seededCharacters,
        characterClears: seededClears,
        partyCoClearCounters: seededCoClears,
    })
    const session = createSession([
        { kind: "characters" },
        { kind: "characterClearCounters" },
        { kind: "partyCoClearCounters" },
    ], loaders)

    assert.strictEqual(session.getFact({ kind: "characters" }), seededCharacters)
    assert.strictEqual(session.getFact({ kind: "characterClearCounters" }), seededClears)
    assert.strictEqual(session.getFact({ kind: "partyCoClearCounters" }), seededCoClears)
})
