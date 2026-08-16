"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { CollectComputer } = require("../src/lib/mission/collect-progress")
const { DegreeComputer } = require("../src/lib/mission/computer-degree")
const { RegularComputer } = require("../src/lib/mission/computer-regular")

const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const catalog = getMissionCatalog()
const requirementRegistry = getMissionFactRequirementRegistry(catalog)

function player() {
    return {
        id: 99,
        rankPoint: 0,
        totalStaminaUsed: 0,
        totalDashes: 0,
        maxComboAchieved: 0,
        totalLoginDays: 0,
    }
}

function createSession(candidates, registry = requirementRegistry, calls = []) {
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => {
            calls.push({ kind: "player" })
            return player()
        })
        .register("collectedItems", ({ key }) => {
            calls.push(key)
            return { "80001": 8, "100000": 9 }
        })
    return new MissionEvaluationSession({
        playerId: 99,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
}

test("one Session shares the merged collected selector across Category 1, 4, and 5", () => {
    const calls = []
    const session = createSession([
        { category: 1, missionId: 66 },
        { category: 4, missionId: 1500 },
        { category: 5, missionId: 41000 },
    ], requirementRegistry, calls)

    const regularContext = RegularComputer.buildContextFromSession(session, 1, [66])
    const collectContext = CollectComputer.buildContextFromSession(session, 4, [1500])
    const degreeContext = DegreeComputer.buildContextFromSession(session, 5, [41000])

    assert.equal(RegularComputer.compute(66, regularContext, 0), 9)
    assert.equal(CollectComputer.compute(1500, collectContext, 0), 8)
    assert.equal(DegreeComputer.compute(41000, degreeContext, 0), 9)
    assert.deepEqual(calls.filter(call => call.kind === "collectedItems"), [
        { kind: "collectedItems", itemIds: [100000] },
        { kind: "collectedItems", itemIds: [80001] },
    ])
})

test("persisted and unsupported Degree requirements reject stray facts before loading", () => {
    const baseRegistry = requirementRegistry
    const persisted = baseRegistry.getRequirement(5, 47000)
    const unsupported = baseRegistry.getRequirement(5, 3000)
    const registry = {
        ...baseRegistry,
        getRequirement(category, missionId) {
            if (category === 5 && missionId === 47000) {
                return { ...persisted, facts: [{ kind: "collectedItems", itemIds: [80001] }] }
            }
            if (category === 5 && missionId === 3000) {
                return { ...unsupported, facts: [{ kind: "missionBattleCounters" }] }
            }
            return baseRegistry.getRequirement(category, missionId)
        },
    }
    const calls = []
    const session = createSession([
        { category: 5, missionId: 47000 },
        { category: 5, missionId: 3000 },
    ], registry, calls)

    assert.throws(
        () => DegreeComputer.buildContextFromSession(session, 5, [47000, 3000]),
        /Degree Session invariant failed.*(?:facts|selector|requirement)/i,
    )
    assert.deepEqual(calls, [])
})

test("Degree ignores non-Degree candidates in a shared Category 1/2/4/6/10 Session", () => {
    const calls = []
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => { calls.push("player"); return player() })
        .register("collectedItems", ({ key }) => { calls.push(key); return {} })
        .register("missionBattleCounters", () => { calls.push("missionBattleCounters"); return {} })
        .register("periodicSnapshot", ({ key }) => { calls.push(key); return null })
    const session = new MissionEvaluationSession({
        playerId: 99,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: [
            { category: 1, missionId: 66 },
            { category: 2, missionId: 1 },
            { category: 4, missionId: 1500 },
            { category: 5, missionId: 1000 },
            { category: 6, missionId: 1 },
            { category: 10, missionId: 1 },
        ],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })

    DegreeComputer.buildContextFromSession(session, 5, [1000])
    assert.deepEqual(calls, ["player"])
})
