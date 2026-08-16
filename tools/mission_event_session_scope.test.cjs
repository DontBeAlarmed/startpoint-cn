"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    getFactKeyId,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { EventSafeComputer } = require("../src/lib/mission/computer-event-safe")
const {
    getBundledStandardMissionTables,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const catalog = getMissionCatalog()
const registry = getMissionFactRequirementRegistry(catalog)
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

const values = {
    player: Object.freeze({ id: 77 }),
    characters: Object.freeze({}),
    characterManaNodes: Object.freeze({}),
    equipment: Object.freeze({}),
    items: Object.freeze({}),
    partyGroups: Object.freeze({}),
    questProgress: Object.freeze({}),
    collectedItems: Object.freeze({}),
    categoryMissionProgress: new Map([[1448, 1]]),
}

function createLoaders() {
    const loaders = new MissionFactLoaderRegistry()
    for (const kind of Object.keys(values)) loaders.register(kind, () => values[kind])
    return loaders
}

function catalogWithEventDefinitions(eventDefinitions) {
    const tables = {
        ...getBundledStandardMissionTables({ "mission_event.json": eventDefinitions }),
        "challenge_dungeon_event_quest.json": require("../assets/challenge_dungeon_event_quest.json"),
        "ranking_event_single_quest.json": require("../assets/ranking_event_single_quest.json"),
        "rush_event_quest.json": require("../assets/rush_event_quest.json"),
        "carnival_event_quest.json": require("../assets/carnival_event_quest.json"),
    }
    return getMissionCatalog({
        info: () => ({ source: "test" }),
        table(tableName) {
            if (Object.prototype.hasOwnProperty.call(tables, tableName)) return tables[tableName]
            throw new Error(`unexpected custom Event Catalog table ${tableName}`)
        },
    })
}

function build(missionIds, requirementRegistry = registry) {
    const loads = []
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: missionIds.map(missionId => ({ category: 3, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createLoaders(),
        observer: { onLoaderCall(key) { loads.push(getFactKeyId(key)) } },
    })
    const context = EventSafeComputer.buildContextFromSession(session, 3, missionIds)
    return { context, loads: loads.sort() }
}

test("Event Session current-state candidates load only their declared facts", () => {
    const cases = [
        [[1201], ["player", "questProgress:1"]],
        [[1204], ["characters", "player", "questProgress:3"]],
        [[1205], ["characterManaNodes", "characters", "player"]],
        [[1212], ["equipment", "player"]],
        [[1220], ["items", "partyGroups:1", "player"]],
        [[1305], ["characters", "player"]],
        [[1201, 1205], ["characterManaNodes", "characters", "player", "questProgress:1"]],
    ]

    for (const [missionIds, expectedLoads] of cases) {
        assert.deepEqual(build(missionIds).loads, expectedLoads, missionIds.join(","))
    }
})

test("Event Session item, quest, and aggregate candidates keep exact selections", () => {
    const item = build([2316])
    assert.deepEqual(item.loads, ["collectedItems:80111", "player"])
    assert.deepEqual([...item.context.eventRules.keys()], [2316])
    assert.deepEqual(build([2008342]).loads, ["player", "questProgress:11"])
    const aggregate = build([1454])
    assert.deepEqual(aggregate.loads, [
        "categoryMissionProgress:3:1448,1449,1450,1451,1452,1453",
        "player",
        "questProgress:13",
    ])
    assert.deepEqual([...aggregate.context.eventRules.keys()].sort((left, right) => left - right), [
        1448, 1449, 1450, 1451, 1452, 1453, 1454,
    ])
    assert.strictEqual(aggregate.context.eventMissionProgress, values.categoryMissionProgress)
})

test("Event Session persisted and unsupported candidates load no Event-specific facts", () => {
    const persisted = build([1200])
    const unsupported = build([1402])
    assert.deepEqual(persisted.loads, ["player"])
    assert.deepEqual([...persisted.context.eventRules], [])
    assert.deepEqual(unsupported.loads, ["player"])
    assert.deepEqual([...unsupported.context.eventRules], [])
    assert.deepEqual(build([1200, 1402]).loads, ["player"])
})

test("Event Session enforces category and candidate boundaries", () => {
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 3, missionId: 1201 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createLoaders(),
    })

    assert.throws(
        () => EventSafeComputer.buildContextFromSession(session, 1, [1201]),
        /only supports category 3/i,
    )
    assert.throws(
        () => EventSafeComputer.buildContextFromSession(session, 3, [1204]),
        /outside the evaluation Session candidates/i,
    )
})

test("Event Session rejects malformed requirements before loading facts", () => {
    const malformed = {
        size: 1,
        entries: [],
        getRequirement(category, missionId) {
            if (category !== 3 || missionId !== 1201) return undefined
            return Object.freeze({
                mode: "computed",
                facts: Object.freeze([{ kind: "questProgress", sections: [2] }]),
                missionDependencies: Object.freeze([]),
            })
        },
        getMissionsForFact() { return [] },
    }
    const loads = []
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog,
        requirementRegistry: malformed,
        candidates: [{ category: 3, missionId: 1201 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createLoaders(),
        observer: { onLoaderCall(key) { loads.push(getFactKeyId(key)) } },
    })

    assert.throws(
        () => EventSafeComputer.buildContextFromSession(session, 3, [1201]),
        /invariant.*facts\/selector/i,
    )
    assert.deepEqual(loads, [])
})

test("Event compute stays bound to the Session Catalog after the global snapshot changes", () => {
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 3, missionId: 2316 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createLoaders(),
    })
    const context = EventSafeComputer.buildContextFromSession(session, 3, [2316])
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "event-compute-must-not-read-global" },
        repository: {
            info: () => ({ source: "test" }),
            table(tableName) {
                throw new Error(`unexpected global Event compute table read: ${tableName}`)
            },
        },
    }
    try {
        assert.equal(EventSafeComputer.compute(2316, {
            ...context,
            collectedItemTotals: { 80111: 12 },
        }, 3), 12)
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("Event Session fails closed when a current-state Catalog rule drifts", () => {
    const eventDefinitions = structuredClone(require("../assets/mission_event.json"))
    eventDefinitions["1201"][0][8] = "2"
    const customCatalog = catalogWithEventDefinitions(eventDefinitions)
    const customRegistry = getMissionFactRequirementRegistry(customCatalog)
    const loads = []
    const session = new MissionEvaluationSession({
        playerId: 77,
        evaluationTime,
        catalog: customCatalog,
        requirementRegistry: customRegistry,
        candidates: [{ category: 3, missionId: 1201 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createLoaders(),
        observer: { onLoaderCall(key) { loads.push(getFactKeyId(key)) } },
    })
    const context = EventSafeComputer.buildContextFromSession(session, 3, [1201])

    assert.equal(customRegistry.getRequirement(3, 1201).mode, "unsupported")
    assert.deepEqual(loads, ["player"])
    assert.equal(context.eventRules.has(1201), false)
    assert.equal(EventSafeComputer.compute(1201, context, 7), 7)
})
