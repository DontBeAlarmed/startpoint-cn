"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const { MissionFactLoaderRegistry } = require("../src/lib/mission/fact-loaders")
const { CollectComputer } = require("../src/lib/mission/collect-progress")

const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

function createSession(requirement, loaderCalls) {
    const row = []
    row[14] = 777777
    const catalog = {
        getDefinition(category, missionId) {
            return category === 4 && missionId === 1500 ? { row } : undefined
        },
    }
    const registry = {
        size: 1,
        entries: [],
        getRequirement(category, missionId) {
            return category === 4 && missionId === 1500 ? requirement : undefined
        },
        getMissionsForFact() { return [] },
    }
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => {
            loaderCalls.count++
            return { id: 42 }
        })
        .register("collectedItems", () => {
            loaderCalls.count++
            return {}
        })
    return new MissionEvaluationSession({
        playerId: 42,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 4, missionId: 1500 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
}

function computed(facts) {
    return Object.freeze({
        mode: "computed",
        facts: Object.freeze(facts),
        missionDependencies: Object.freeze([]),
    })
}

for (const [label, facts] of [
    ["mismatched selector", [{ kind: "collectedItems", itemIds: [888888] }]],
    ["missing selector fact", []],
    ["multiple selectors", [{ kind: "collectedItems", itemIds: [777777, 888888] }]],
]) {
    test(`Collect Session rejects ${label} before any loader`, () => {
        const loaderCalls = { count: 0 }
        const session = createSession(computed(facts), loaderCalls)

        assert.throws(
            () => CollectComputer.buildContextFromSession(session, 4, [1500]),
            /Collect Session invariant.*4:1500.*selector/i,
        )
        assert.equal(loaderCalls.count, 0)
    })
}

test("Collect Session rejects selectors crossed between missions before any loader", () => {
    const loaderCalls = { count: 0 }
    const selectors = new Map([[1500, 777777], [1574, 888888]])
    const factsByMission = new Map([
        [1500, [{ kind: "collectedItems", itemIds: [888888] }]],
        [1574, [{ kind: "collectedItems", itemIds: [777777] }]],
    ])
    const catalog = {
        getDefinition(category, missionId) {
            if (category !== 4 || !selectors.has(missionId)) return undefined
            const row = []
            row[14] = selectors.get(missionId)
            return { row }
        },
    }
    const registry = {
        size: 2,
        entries: [],
        getRequirement(category, missionId) {
            return category === 4 && factsByMission.has(missionId)
                ? computed(factsByMission.get(missionId))
                : undefined
        },
        getMissionsForFact() { return [] },
    }
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => { loaderCalls.count++; return { id: 42 } })
        .register("collectedItems", () => { loaderCalls.count++; return {} })
    const session = new MissionEvaluationSession({
        playerId: 42,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 4, missionId: 1500 }, { category: 4, missionId: 1574 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })

    assert.throws(
        () => CollectComputer.buildContextFromSession(session, 4, [1500, 1574]),
        /Collect Session invariant.*4:1500.*selector/i,
    )
    assert.equal(loaderCalls.count, 0)
})
