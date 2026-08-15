"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    allFacts,
    assertLoaderKeys,
    bundledMissionContentRepository,
    computeDegreeProgress,
    createSession,
    customDegreeCatalog,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
    installGlobalRepository,
    player,
    productionContentSnapshotProvider,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

const previousSnapshot = productionContentSnapshotProvider.snapshot
test.after(() => { productionContentSnapshotProvider.snapshot = previousSnapshot })

test("Degree exposes a Category 5 Session context builder", () => {
    assert.equal(typeof DegreeComputer.buildContextFromSession, "function")
    assert.throws(() => DegreeComputer.buildContextFromSession({}, 4, []), /category 5/i)
})

test("Degree compute keeps using rules bound into an already-built context", () => {
    productionContentSnapshotProvider.snapshot = null
    const context = {
        category: 5,
        playerId: 99,
        player: player(999999),
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        degreeRules: new Map([[1000, {
            missionId: 1000,
            kind: "playerRank",
            pattern: "degree_player_rank_growth_1",
        }]]),
    }
    const expected = DegreeComputer.compute(1000, context, 0)
    assert.ok(expected > 0)
    const definitions = structuredClone(bundledMissionContentRepository.table("mission_degree.json"))
    definitions[1000][0][1] = "custom_not_player_rank"
    installGlobalRepository(repositoryWith({ "mission_degree.json": definitions }, "global-drift"))
    assert.equal(DegreeComputer.compute(1000, context, 0), expected)
})

test("Degree Session follows the supplied Catalog mission pattern instead of global Content", () => {
    productionContentSnapshotProvider.snapshot = null
    const catalog = customDegreeCatalog(definitions => {
        definitions[1000][0][1] = "degree_companion_add_custom"
    })
    const calls = []
    const session = createSession(catalog, [1000], {
        player: player(),
        characters: {
            111001: { overLimitStep: 0, exp: 0, bondTokenList: [] },
            111002: { overLimitStep: 0, exp: 0, bondTokenList: [] },
        },
    }, calls)
    const context = DegreeComputer.buildContextFromSession(session, 5, [1000])
    assert.equal(DegreeComputer.compute(1000, context, 0), 2)
    assert.deepEqual(calls.map(call => call.kind), ["characters", "player"])
})

test("Degree Session loads each requested fact family once and merges selected facts", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const cases = [
        [[1000], ["player"]],
        [[2000], ["characters", "player"]],
        [[5000], ["characterManaNodes", "player"]],
        [[1111001], ["characters", "characterManaNodes", "player"]],
        [[13000], ["missionBattleCounters", "player"]],
        [[16000], ["degreeBattleStats", "player"]],
        [[9000], ["questProgress:1,4", "player"]],
        [[12000], ["questProgress:15", "player"]],
        [[46000], ["shopPurchases:2", "player"]],
        [[43000], ["equipment", "player"]],
        [[8000, 3000], ["player"]],
        [[11010, 57010, 58000, 68000, 61040, 62330], [
            "questProgress:2,7,18,21,22,26", "player",
        ]],
        [[41000, 70000, 70010], ["collectedItems:70014,70048,100000", "player"]],
    ]
    for (const [missionIds, expected] of cases) assertLoaderKeys(assert, catalog, missionIds, expected)
})

test("Degree Session rejects a requirement selector drift before any loader runs", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    const baseRegistry = getMissionFactRequirementRegistry(catalog)
    const calls = []
    const registry = {
        ...baseRegistry,
        getRequirement(category, missionId) {
            if (category === 5 && missionId === 70000) {
                return {
                    mode: "computed",
                    facts: [{ kind: "collectedItems", itemIds: [79999] }],
                    missionDependencies: [],
                }
            }
            return baseRegistry.getRequirement(category, missionId)
        },
    }
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => { calls.push("player"); return player() })
        .register("collectedItems", () => { calls.push("collectedItems"); return {} })
    const session = new MissionEvaluationSession({
        playerId: 99,
        evaluationTime: new Date(),
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 5, missionId: 70000 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    assert.throws(
        () => DegreeComputer.buildContextFromSession(session, 5, [70000]),
        /invariant.*selector/i,
    )
    assert.deepEqual(calls, [])
})

test("Degree fails a malformed authoritative level reward closed without character reads", () => {
    const catalog = customDegreeCatalog(
        () => undefined,
        rewards => { rewards[3010][1][0][1] = "81" },
    )
    const calls = []
    const context = DegreeComputer.buildContextFromSession(
        createSession(catalog, [3010], allFacts(), calls), 5, [3010],
    )
    assert.equal(DegreeComputer.compute(3010, context, 9), 9)
    assert.deepEqual(calls.map(call => call.kind), ["player"])
})

test("Degree compute fails closed for an unknown runtime rule kind", () => {
    const context = {
        category: 5,
        playerId: 99,
        player: player(999999),
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        degreeStats: {},
    }
    assert.equal(computeDegreeProgress({
        missionId: 999999,
        pattern: "future-degree-rule",
        facts: [],
        kind: "future-runtime-kind",
    }, context, 13), 13)
})
