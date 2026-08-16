"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const test = require("node:test")

const mission = require("../src/lib/mission")
const {
    CATALOG,
    createSession,
    requirement,
    requirementRegistry,
} = require("./helpers/mission-evaluation-session-fixture.cjs")

const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    getFactKeyId,
} = mission

function observerWithThrowingGetter(property, onRead) {
    return Object.defineProperty({}, property, {
        get() {
            onRead()
            throw new Error(`${property} getter failed`)
        },
    })
}

test("construction fixes session inputs and performs no fact loads", () => {
    let loaderCalls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        loaderCalls++
        return { id: 77 }
    })
    const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
    const dependencies = [{ category: 2, missionId: 20 }]
    const ref = Object.freeze({ category: 1, missionId: 10 })
    const unsupportedRef = Object.freeze({ category: 3, missionId: 30 })
    const registry = requirementRegistry([{
        ...ref,
        requirement: requirement([], {
            mode: "persisted",
            missionDependencies: dependencies,
        }),
    }, {
        ...dependencies[0],
        requirement: requirement([], { mode: "persisted" }),
    }, {
        ...unsupportedRef,
        requirement: requirement([], { mode: "unsupported" }),
    }])

    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog: CATALOG,
        requirementRegistry: registry,
        candidates: [ref, unsupportedRef],
        loaders,
    })
    evaluationTime.setUTCFullYear(2030)

    assert.equal(loaderCalls, 0)
    assert.equal(session.playerId, 77)
    assert.equal(session.evaluationTime.toISOString(), "2024-08-14T12:00:00.000Z")
    assert.strictEqual(session.catalog, CATALOG)
    assert.strictEqual(session.requirementRegistry, registry)
    assert.deepEqual(session.factLoadPlan.keys, [])
    assert.deepEqual(session.candidateRequirements[0].requirement.missionDependencies, dependencies)
})

test("runtime mutation cannot replace fixed inputs or disrupt the private fact cache", () => {
    const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
    const ref = Object.freeze({ category: 1, missionId: 10 })
    const registry = requirementRegistry([{
        ...ref,
        requirement: requirement([{ kind: "player" }]),
    }])
    const contexts = []
    const value = { id: 77 }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", context => {
        contexts.push(context)
        return value
    })
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog: CATALOG,
        requirementRegistry: registry,
        candidates: [ref],
        loaders,
    })

    assert.equal(Object.isFrozen(session), true)
    assert.throws(() => { session.playerId = 999 }, TypeError)
    assert.throws(() => { session.catalog = Object.freeze({ name: "replacement" }) }, TypeError)
    assert.throws(() => { session.requirementRegistry = requirementRegistry([]) }, TypeError)
    assert.throws(() => { session.factLoadPlan = Object.freeze({ keys: [], keyIds: [] }) }, TypeError)
    assert.throws(() => { session.evaluationTime = new Date("2030-01-01T00:00:00.000Z") }, TypeError)
    session.evaluationTime.setUTCFullYear(2030)

    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0].playerId, 77)
    assert.equal(contexts[0].evaluationTime.toISOString(), "2024-08-14T12:00:00.000Z")
    assert.strictEqual(contexts[0].catalog, CATALOG)
    assert.strictEqual(contexts[0].requirementRegistry, registry)
})

test("runtime map attacks cannot clear session state or execute a loader twice", () => {
    let calls = 0
    const value = { id: 77 }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        calls++
        return value
    })
    const session = createSession([{ kind: "player" }], loaders)
    const exposedMaps = [session, loaders].flatMap(target => (
        Reflect.ownKeys(target)
            .map(key => target[key])
            .filter(candidate => candidate instanceof Map)
    ))

    for (const map of exposedMaps) map.clear()

    assert.equal(exposedMaps.length, 0)
    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.equal(calls, 1)
})

test("a session snapshots missing planned loaders before later registry registration", () => {
    let calls = 0
    const loaders = new MissionFactLoaderRegistry()
    const existing = createSession([{ kind: "player" }], loaders)
    loaders.register("player", () => {
        calls++
        return { id: 77 }
    })

    assert.throws(
        () => existing.getFact({ kind: "player" }),
        /no.*loader|loader.*not registered/i,
    )
    assert.equal(createSession([{ kind: "player" }], loaders).getFact({ kind: "player" }).id, 77)
    assert.equal(calls, 1)
})

test("empty candidates keep an empty plan and execute zero loaders", () => {
    let calls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        calls++
        return { id: 77 }
    })
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime: new Date(),
        catalog: CATALOG,
        requirementRegistry: requirementRegistry([]),
        candidates: [],
        loaders,
    })

    assert.deepEqual(session.factLoadPlan.keys, [])
    assert.equal(calls, 0)
})

test("normalizes a fact key and executes its synchronous loader once", () => {
    let calls = 0
    const value = { sections: [1, 4] }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("questProgress", ({ key, playerId }) => {
        calls++
        assert.equal(playerId, 77)
        assert.deepEqual(key.sections, [1, 4])
        return value
    })
    const session = createSession([
        { kind: "questProgress", sections: [4, 1, 4] },
    ], loaders)

    assert.deepEqual(session.factLoadPlan.keyIds, ["questProgress:1,4"])
    assert.strictEqual(session.getFact({ kind: "questProgress", sections: [1, 4] }), value)
    assert.strictEqual(session.getFact({ kind: "questProgress", sections: [4, 1] }), value)
    assert.equal(calls, 1)
})

test("merged selections serve declared subsets from one covering cache entry", () => {
    let calls = 0
    const loaded = { marker: "merged" }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("questProgress", ({ key }) => {
        calls++
        assert.deepEqual(key.sections, [1, 4])
        return loaded
    })
    const session = createSession([
        { kind: "questProgress", sections: [1] },
        { kind: "questProgress", sections: [4] },
    ], loaders)

    assert.strictEqual(session.getFact({ kind: "questProgress", sections: [1] }), loaded)
    assert.strictEqual(session.getFact({ kind: "questProgress", sections: [4] }), loaded)
    assert.equal(calls, 1)
    assert.throws(
        () => session.getFact({ kind: "questProgress", sections: [1, 8] }),
        /not declared|outside.*declared/i,
    )
    assert.throws(
        () => session.getFact({ kind: "questProgress", sections: "all" }),
        /not declared|outside.*declared/i,
    )
})

test("all selection covers subsets for quest progress and collected items", () => {
    let questCalls = 0
    let itemCalls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("questProgress", ({ key }) => {
        questCalls++
        assert.equal(key.sections, "all")
        return { kind: "quests" }
    })
    loaders.register("collectedItems", ({ key }) => {
        itemCalls++
        assert.equal(key.itemIds, "all")
        return { kind: "items" }
    })
    const session = createSession([
        { kind: "questProgress", sections: "all" },
        { kind: "collectedItems", itemIds: "all" },
    ], loaders)

    assert.strictEqual(
        session.getFact({ kind: "questProgress", sections: [4] }),
        session.getFact({ kind: "questProgress", sections: "all" }),
    )
    assert.strictEqual(
        session.getFact({ kind: "collectedItems", itemIds: [99] }),
        session.getFact({ kind: "collectedItems", itemIds: "all" }),
    )
    assert.equal(questCalls, 1)
    assert.equal(itemCalls, 1)
})

test("collected item selections reject requests outside the declared scope", () => {
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("collectedItems", () => ({ 5: 1, 9: 2 }))
    const session = createSession([
        { kind: "collectedItems", itemIds: [9, 5] },
    ], loaders)

    assert.deepEqual(
        session.getFact({ kind: "collectedItems", itemIds: [5] }),
        { 5: 1, 9: 2 },
    )
    assert.throws(
        () => session.getFact({ kind: "collectedItems", itemIds: [10] }),
        /not declared|outside.*declared/i,
    )
})

test("fails closed for undeclared facts, missing loaders, and duplicate kinds", () => {
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => ({ id: 77 }))
    assert.throws(
        () => loaders.register("player", () => ({ id: 88 })),
        /already registered|duplicate/i,
    )

    const playerSession = createSession([{ kind: "player" }], loaders)
    assert.throws(
        () => playerSession.getFact({ kind: "missionBattleCounters" }),
        /not declared/i,
    )

    const missingLoaderSession = createSession(
        [{ kind: "missionBattleCounters" }],
        new MissionFactLoaderRegistry(),
    )
    assert.throws(
        () => missingLoaderSession.getFact({ kind: "missionBattleCounters" }),
        /no.*loader|loader.*not registered/i,
    )

    const missingShopLoaderSession = createSession(
        [{ kind: "shopPurchases", shopType: 2 }],
        new MissionFactLoaderRegistry(),
    )
    assert.throws(
        () => missingShopLoaderSession.getFact({ kind: "shopPurchases", shopType: 2 }),
        /no.*loader|loader.*not registered/i,
    )
})

test("separate sessions do not share values and failed loads are not retried", () => {
    let calls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => ({ call: ++calls }))
    const first = createSession([{ kind: "player" }], loaders)
    const second = createSession([{ kind: "player" }], loaders)

    assert.equal(first.getFact({ kind: "player" }).call, 1)
    assert.equal(first.getFact({ kind: "player" }).call, 1)
    assert.equal(second.getFact({ kind: "player" }).call, 2)

    let failures = 0
    const failingLoaders = new MissionFactLoaderRegistry()
    failingLoaders.register("player", () => {
        failures++
        throw new Error("load failed")
    })
    const failing = createSession([{ kind: "player" }], failingLoaders)
    assert.throws(() => failing.getFact({ kind: "player" }), /load failed/)
    assert.throws(() => failing.getFact({ kind: "player" }), /load failed/)
    assert.equal(failures, 1)
})

test("fails synchronous reentrant reads without invoking the loader twice", () => {
    let calls = 0
    let session
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        calls++
        return session.getFact({ kind: "player" })
    })
    session = createSession([{ kind: "player" }], loaders)

    assert.throws(() => session.getFact({ kind: "player" }), /reentrant|already loading/i)
    assert.throws(() => session.getFact({ kind: "player" }), /reentrant|already loading/i)
    assert.equal(calls, 1)
})

test("observer receives low-cost plan, loader, and cache events without changing behavior", () => {
    const events = []
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => ({ id: 77 }))
    const session = createSession([{ kind: "player" }], loaders, {
        observer: {
            onPlan(plan) {
                events.push(["plan", ...plan.keyIds])
                throw new Error("observer failures are ignored")
            },
            onLoaderCall(key) {
                events.push(["load", getFactKeyId(key)])
                throw new Error("observer failures are ignored")
            },
            onCacheHit(requestedKey, loadedKey) {
                events.push(["hit", getFactKeyId(requestedKey), getFactKeyId(loadedKey)])
                throw new Error("observer failures are ignored")
            },
        },
    })

    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.deepEqual(events, [
        ["plan", "player"],
        ["load", "player"],
        ["hit", "player", "player"],
    ])
})

test("observer callbacks can read facts without recursively observing nested reads", () => {
    const loaderEvents = []
    const cacheEvents = []
    const loaderCalls = { player: 0, missionBattleCounters: 0 }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        loaderCalls.player++
        return { id: 77 }
    })
    loaders.register("missionBattleCounters", () => {
        loaderCalls.missionBattleCounters++
        return { singlePlayCount: 3 }
    })
    let session
    session = createSession([
        { kind: "player" },
        { kind: "missionBattleCounters" },
    ], loaders, {
        observer: {
            onLoaderCall(key) {
                loaderEvents.push(key.kind)
                if (key.kind === "player") {
                    assert.equal(
                        session.getFact({ kind: "missionBattleCounters" }).singlePlayCount,
                        3,
                    )
                }
            },
            onCacheHit(requestedKey) {
                cacheEvents.push(requestedKey.kind)
                if (requestedKey.kind === "player") {
                    assert.equal(
                        session.getFact({ kind: "missionBattleCounters" }).singlePlayCount,
                        3,
                    )
                }
            },
        },
    })

    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.deepEqual(loaderEvents, ["player"])
    assert.deepEqual(cacheEvents, ["player"])
    assert.deepEqual(loaderCalls, { player: 1, missionBattleCounters: 1 })
})

test("rejected Promise observer callbacks are consumed for all three entry points", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--unhandled-rejections=strict",
            path.join(__dirname, "helpers/mission-evaluation-rejected-observer-worker.cjs"),
        ],
        { encoding: "utf8" },
    )

    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.match(result.stdout, /onPlan,onLoaderCall,onCacheHit consumed/)
})

test("an onPlan getter failure is read once and cannot abort construction", () => {
    let getterReads = 0
    let loaderCalls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        loaderCalls++
        return { id: 77 }
    })
    const session = createSession([{ kind: "player" }], loaders, {
        observer: observerWithThrowingGetter("onPlan", () => { getterReads++ }),
    })

    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.equal(getterReads, 1)
    assert.equal(loaderCalls, 1)
})

test("an onLoaderCall getter failure is read once and cannot abort loading", () => {
    let getterReads = 0
    let loaderCalls = 0
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        loaderCalls++
        return { id: 77 }
    })
    const session = createSession([{ kind: "player" }], loaders, {
        observer: observerWithThrowingGetter("onLoaderCall", () => { getterReads++ }),
    })

    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.equal(session.getFact({ kind: "player" }).id, 77)
    assert.equal(getterReads, 1)
    assert.equal(loaderCalls, 1)
})

test("an onCacheHit getter failure is read once and cannot abort a cache hit", () => {
    let getterReads = 0
    let loaderCalls = 0
    const value = { id: 77 }
    const loaders = new MissionFactLoaderRegistry()
    loaders.register("player", () => {
        loaderCalls++
        return value
    })
    const session = createSession([{ kind: "player" }], loaders, {
        observer: observerWithThrowingGetter("onCacheHit", () => { getterReads++ }),
    })

    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.strictEqual(session.getFact({ kind: "player" }), value)
    assert.equal(getterReads, 1)
    assert.equal(loaderCalls, 1)
})
