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
        ["snapshot", 77, "daily"],
        ["snapshot", 77, "weekly"],
        ["passType", 9],
        ["snapshot", 77, "pass-week:9"],
    ])
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
