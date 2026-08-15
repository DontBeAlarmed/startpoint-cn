"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const bundledExQuests = require("../assets/ex_quest.json")
const bundledMainQuests = require("../assets/main_quest.json")

const database = require("../src/data/db")
const originalGetDb = database.getDb
let databaseCalls = 0
database.getDb = () => {
    databaseCalls++
    throw new Error("FactRequirementRegistry must not access the database")
}

const mission = require("../src/lib/mission")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    bundledMissionContentRepository,
} = require("../src/lib/mission/mission-catalog-source")
const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const { getRegularComputedMissionIds } = require("../src/lib/mission/computer-regular")
const { getEventSafeMissionIds } = require("../src/lib/mission/computer-event-safe")
const {
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission/requirements/registry")

test.after(() => {
    database.getDb = originalGetDb
})

function assertDeepFrozen(value, seen = new Set()) {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

function factIds(requirement) {
    return requirement.facts.map(mission.getFactKeyId)
}

function bundledRuntimeTable(tableName) {
    if (tableName === "main_quest.json") return bundledMainQuests
    if (tableName === "ex_quest.json") return bundledExQuests
    return bundledMissionContentRepository.table(tableName)
}

function forwardingCatalog(source, overrides = new Map(), options = {}) {
    const removedDefinitions = options.removedDefinitions ?? new Set()
    const removedRewardStages = options.removedRewardStages ?? new Set()
    const rewardStageOverrides = options.rewardStageOverrides ?? new Map()
    return Object.freeze({
        getDefinitions(category) {
            return source.getDefinitions(category)
                .filter(definition => !removedDefinitions.has(`${category}:${definition.missionId}`))
                .map(definition => (
                    overrides.get(`${category}:${definition.missionId}`) ?? definition
                ))
        },
        getDefinition(category, missionId) {
            if (removedDefinitions.has(`${category}:${missionId}`)) return undefined
            return overrides.get(`${category}:${missionId}`)
                ?? source.getDefinition(category, missionId)
        },
        getMissionIds: source.getMissionIds.bind(source),
        getDefinitionsByPattern: source.getDefinitionsByPattern.bind(source),
        getRewardStages(category, missionId) {
            return source.getRewardStages(category, missionId)
                .filter(stage => !removedRewardStages.has(
                    `${category}:${missionId}:${stage.stage}`,
                ))
                .map(stage => (
                    rewardStageOverrides.get(`${category}:${missionId}:${stage.stage}`) ?? stage
                ))
        },
        getRewardStage(category, missionId, stage) {
            const key = `${category}:${missionId}:${stage}`
            return removedRewardStages.has(key)
                ? undefined
                : rewardStageOverrides.get(key) ?? source.getRewardStage(category, missionId, stage)
        },
        isEnabledAt: source.isEnabledAt.bind(source),
        getAwakeMissionIdsByCharacter: source.getAwakeMissionIdsByCharacter.bind(source),
    })
}

function withDefinitionField(source, rowIndex, value, pattern = source.pattern) {
    return Object.freeze({
        ...source,
        pattern,
        row: Object.freeze(source.row.map((entry, index) => index === rowIndex ? value : entry)),
    })
}

function assertUnsupported(requirement, reasonPattern) {
    assert.equal(requirement.mode, "unsupported")
    assert.deepEqual(requirement.facts, [])
    assert.deepEqual(requirement.missionDependencies, [])
    assert.match(requirement.reason, reasonPattern)
}

test("classifies every bundled catalog definition exactly once", () => {
    const catalog = getMissionCatalog()
    const registry = getMissionFactRequirementRegistry(catalog)
    const definitions = Array.from({ length: 10 }, (_, index) => index + 1)
        .flatMap(category => catalog.getDefinitions(category))
    const refs = registry.entries.map(entry => `${entry.category}:${entry.missionId}`)

    assert.equal(registry.size, definitions.length)
    assert.equal(registry.entries.length, definitions.length)
    assert.equal(new Set(refs).size, definitions.length)
    assert.deepEqual(refs, [...refs].sort((left, right) => {
        const [leftCategory, leftMissionId] = left.split(":").map(Number)
        const [rightCategory, rightMissionId] = right.split(":").map(Number)
        return leftCategory - rightCategory || leftMissionId - rightMissionId
    }))
    for (const definition of definitions) {
        assert.ok(registry.getRequirement(definition.category, definition.missionId))
    }
    assert.equal(registry.getRequirement(99, 1), undefined)
    assert.equal(registry.getRequirement(1, 999999), undefined)
    assert.equal(registry.getRequirement(0, 0), undefined)
})

test("keeps computed, persisted, and unsupported meanings distinct", () => {
    const registry = getMissionFactRequirementRegistry()

    assert.equal(registry.getRequirement(1, 1).mode, "computed")
    assert.equal(registry.getRequirement(3, 1200).mode, "persisted")
    assert.equal(registry.getRequirement(3, 1402).mode, "unsupported")
    assert.equal(registry.getRequirement(5, 8000).mode, "persisted")
    assert.equal(registry.getRequirement(5, 3000).mode, "unsupported")
    assert.deepEqual(registry.getRequirement(3, 1200).facts, [])
    assert.deepEqual(registry.getRequirement(3, 1402).facts, [])
})

test("covers every authoritative Regular computed mission with exact fact domains", () => {
    const catalog = getMissionCatalog()
    const registry = getMissionFactRequirementRegistry(catalog)
    const computedMissionIds = getRegularComputedMissionIds()
    const unsupportedMissionIds = computedMissionIds.filter(missionId => (
        registry.getRequirement(1, missionId).mode === "unsupported"
    ))

    assert.deepEqual(unsupportedMissionIds, [])
    assert.deepEqual(factIds(registry.getRequirement(1, 5)), ["degreeBattleStats"])
    for (const missionId of [...Array.from({ length: 14 }, (_, index) => index + 42), 93]) {
        const requirement = registry.getRequirement(1, missionId)
        assert.equal(requirement.mode, "computed", `Regular ${missionId}`)
        assert.deepEqual(factIds(requirement), ["questProgress:1"], `Regular ${missionId}`)
    }

    const sameContent = getMissionFactRequirementRegistry(forwardingCatalog(catalog))
    assert.equal(sameContent.getRequirement(1, 42).mode, "computed")
    const changedDefinition = withDefinitionField(catalog.getDefinition(1, 42), 10, "3")
    const changedCatalog = forwardingCatalog(
        catalog,
        new Map([["1:42", changedDefinition]]),
    )
    assertUnsupported(
        getMissionFactRequirementRegistry(changedCatalog).getRequirement(1, 42),
        /authoritative|computer|definition|mapping/i,
    )
})

test("maps every Degree fact family to the authoritative FactKey domain", () => {
    const registry = getMissionFactRequirementRegistry()
    const cases = [
        [1000, ["player"]],
        [2000, ["characters"]],
        [5000, ["characterManaNodes"]],
        [7000, ["questProgress:3"]],
        [9000, ["questProgress:1,4"]],
        [10000, ["missionBattleCounters"]],
        [11010, ["questProgress:2"]],
        [12000, ["questProgress:15"]],
        [16000, ["degreeBattleStats"]],
        [41000, ["collectedItems:all"]],
        [43000, ["equipment"]],
        [46000, ["shopPurchases:2"]],
        [57010, ["questProgress:21"]],
        [58000, ["questProgress:18"]],
        [61040, ["questProgress:22"]],
        [62330, ["questProgress:26"]],
        [68000, ["questProgress:7"]],
        [70000, ["collectedItems:70014"]],
    ]

    for (const [missionId, expectedFacts] of cases) {
        const requirement = registry.getRequirement(5, missionId)
        assert.equal(requirement.mode, "computed", `Degree ${missionId}`)
        assert.deepEqual(factIds(requirement), expectedFacts, `Degree ${missionId}`)
    }
})

test("uses actual child missions for Daily and Awake aggregate dependencies", () => {
    const registry = getMissionFactRequirementRegistry()

    assert.deepEqual(registry.getRequirement(2, 5), {
        mode: "computed",
        facts: [],
        missionDependencies: [
            { category: 2, missionId: 1 },
            { category: 2, missionId: 2 },
            { category: 2, missionId: 3 },
            { category: 2, missionId: 4 },
        ],
    })
    assert.deepEqual(registry.getRequirement(9, 14).missionDependencies, [
        { category: 9, missionId: 11 },
        { category: 9, missionId: 12 },
        { category: 9, missionId: 13 },
    ])
    assert.equal(factIds(registry.getRequirement(2, 5)).includes("categoryMissionProgress:2"), false)
    assert.equal(factIds(registry.getRequirement(9, 14)).includes("categoryMissionProgress:9"), false)
})

test("separates Event producers from fail-closed selectors", () => {
    const registry = getMissionFactRequirementRegistry()

    assert.equal(registry.getRequirement(3, 1200).mode, "persisted")
    assert.equal(registry.getRequirement(3, 1225).mode, "persisted")
    assert.equal(registry.getRequirement(3, 1402).mode, "unsupported")
    assert.match(registry.getRequirement(3, 1402).reason, /authoritative|mapping|selector/i)
})

test("matches Event safe coverage and validates current-state reward stages", () => {
    const catalog = getMissionCatalog()
    const registry = getMissionFactRequirementRegistry(catalog)
    const safeMissionIds = getEventSafeMissionIds()
    const computedMissionIds = registry.entries
        .filter(entry => entry.category === 3 && entry.requirement.mode === "computed")
        .map(entry => entry.missionId)

    assert.deepEqual(computedMissionIds, safeMissionIds)
    assert.equal(getMissionFactRequirementRegistry(forwardingCatalog(catalog))
        .getRequirement(3, 1201).mode, "computed")

    const sourceStage = catalog.getRewardStage(3, 1201, 1)
    const withoutReward = forwardingCatalog(catalog, new Map(), {
        removedRewardStages: new Set(["3:1201:1"]),
    })
    const wrongTarget = forwardingCatalog(catalog, new Map(), {
        rewardStageOverrides: new Map([["3:1201:1", Object.freeze({
            ...sourceStage,
            targetProgress: sourceStage.targetProgress + 1,
        })]]),
    })
    const changedDefinition = withDefinitionField(catalog.getDefinition(3, 1201), 8, "2")
    const changedSchema = forwardingCatalog(
        catalog,
        new Map([["3:1201", changedDefinition]]),
    )

    assertUnsupported(
        getMissionFactRequirementRegistry(withoutReward).getRequirement(3, 1201),
        /authoritative|mapping|reward|target/i,
    )
    assertUnsupported(
        getMissionFactRequirementRegistry(wrongTarget).getRequirement(3, 1201),
        /authoritative|mapping|reward|target/i,
    )
    assertUnsupported(
        getMissionFactRequirementRegistry(changedSchema).getRequirement(3, 1201),
        /authoritative|mapping|reward|target/i,
    )
})

test("separates recomputable, atomic, and fail-closed Awake families", () => {
    const registry = getMissionFactRequirementRegistry()

    assert.deepEqual(factIds(registry.getRequirement(9, 1410033)), ["characters"])
    assert.equal(registry.getRequirement(9, 1410033).mode, "computed")
    assert.equal(registry.getRequirement(9, 1110013).mode, "persisted")
    assert.deepEqual(registry.getRequirement(9, 1110013).facts, [])

    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(9, 1110013)
    const customDefinition = Object.freeze({
        ...source,
        pattern: "custom-unknown-awake-family",
        row: Object.freeze(source.row.map((value, index) => index === 4 ? "999" : value)),
    })
    const customRegistry = getMissionFactRequirementRegistry(forwardingCatalog(
        catalog,
        new Map([["9:1110013", customDefinition]]),
    ))
    assert.equal(customRegistry.getRequirement(9, 1110013).mode, "unsupported")
})

test("normalizes and merges facts, indexes them in stable order, and freezes public results", () => {
    const registry = getMissionFactRequirementRegistry()
    const episode = registry.getRequirement(5, 9000)
    const reverseA = registry.getMissionsForFact({ kind: "questProgress", sections: [4, 1, 4] })
    const reverseB = registry.getMissionsForFact({ kind: "questProgress", sections: [1, 4] })

    assert.deepEqual(episode.facts, [{ kind: "questProgress", sections: [1, 4] }])
    assert.equal(reverseA, reverseB)
    assert.deepEqual(reverseA, [...reverseA].sort((left, right) => (
        left.category - right.category || left.missionId - right.missionId
    )))
    assert.equal(reverseA.some(ref => ref.category === 5 && ref.missionId === 9000), true)
    assert.deepEqual(registry.getMissionsForFact({ kind: "passState", eventId: 999999 }), [])

    assertDeepFrozen(registry)
    assertDeepFrozen(registry.entries)
    assertDeepFrozen(episode)
    assertDeepFrozen(reverseA)
    assert.throws(() => episode.facts.push({ kind: "player" }), TypeError)
    assert.throws(() => episode.missionDependencies.push({ category: 5, missionId: 1 }), TypeError)
})

test("caches by MissionCatalog identity without leaking global Degree definitions", () => {
    const catalog = getMissionCatalog()
    const firstIdentity = forwardingCatalog(catalog)
    const secondIdentity = forwardingCatalog(catalog)

    assert.equal(
        getMissionFactRequirementRegistry(firstIdentity),
        getMissionFactRequirementRegistry(firstIdentity),
    )
    assert.notEqual(
        getMissionFactRequirementRegistry(firstIdentity),
        getMissionFactRequirementRegistry(secondIdentity),
    )

    const source = catalog.getDefinition(5, 9000)
    const customDefinition = Object.freeze({
        ...source,
        pattern: "custom-unsupported-degree",
        row: Object.freeze(source.row.map((value, index) => index === 3 ? "999" : value)),
    })
    const customCatalog = forwardingCatalog(
        catalog,
        new Map([["5:9000", customDefinition]]),
    )
    assert.equal(
        getMissionFactRequirementRegistry(customCatalog).getRequirement(5, 9000).mode,
        "unsupported",
    )
})

test("isolates Event and Awake provider views from current snapshot build order", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    try {
        productionContentSnapshotProvider.snapshot = null
        const bundledCatalog = getMissionCatalog()
        const bundledRegistry = getMissionFactRequirementRegistry(bundledCatalog)
        assert.equal(bundledRegistry.getRequirement(3, 1200).mode, "persisted")
        assert.equal(bundledRegistry.getRequirement(9, 1110013).mode, "persisted")

        const eventDefinitions = bundledMissionContentRepository.table("mission_event.json")
        const awakeDefinitions = bundledMissionContentRepository.table("mission_char_awake.json")
        const runtimeTables = {
            "mission_event.json": {
                ...eventDefinitions,
                1200: [[...eventDefinitions["1200"][0]]],
            },
            "mission_char_awake.json": {
                ...awakeDefinitions,
                1110013: [[...awakeDefinitions["1110013"][0]]],
            },
        }
        runtimeTables["mission_event.json"][1200][0][2] = "999"
        runtimeTables["mission_char_awake.json"][1110013][0][4] = "999"
        const runtimeRepository = {
            info: () => ({ source: "mission-requirement-runtime" }),
            table(tableName) {
                return runtimeTables[tableName]
                    ?? bundledRuntimeTable(tableName)
            },
        }
        productionContentSnapshotProvider.snapshot = {
            cdn: {},
            archiveSources: { schemaVersion: 1, archives: [] },
            repository: runtimeRepository,
        }

        const runtimeCatalog = getMissionCatalog(runtimeRepository)
        const runtimeRegistry = getMissionFactRequirementRegistry(runtimeCatalog)
        assertUnsupported(runtimeRegistry.getRequirement(3, 1200), /producer|schema|contract/i)
        assertUnsupported(runtimeRegistry.getRequirement(9, 1110013), /awake|schema|family/i)

        const sameBundledContent = getMissionFactRequirementRegistry(
            forwardingCatalog(bundledCatalog),
        )
        assert.equal(sameBundledContent.getRequirement(3, 1200).mode, "persisted")
        assert.equal(sameBundledContent.getRequirement(9, 1110013).mode, "persisted")
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("uses the supplied Catalog reward stage for authoritative Degree levels", () => {
    const catalog = getMissionCatalog()
    const withoutReward = forwardingCatalog(catalog, new Map(), {
        removedRewardStages: new Set(["5:3010:1"]),
    })
    const sourceStage = catalog.getRewardStage(5, 3010, 1)
    const wrongTarget = forwardingCatalog(catalog, new Map(), {
        rewardStageOverrides: new Map([["5:3010:1", Object.freeze({
            ...sourceStage,
            targetProgress: sourceStage.targetProgress + 1,
        })]]),
    })

    assert.equal(getMissionFactRequirementRegistry(catalog)
        .getRequirement(5, 3010).mode, "computed")
    assertUnsupported(
        getMissionFactRequirementRegistry(withoutReward).getRequirement(5, 3010),
        /reward|authoritative/i,
    )
    assertUnsupported(
        getMissionFactRequirementRegistry(wrongTarget).getRequirement(5, 3010),
        /reward|authoritative/i,
    )
})

test("keeps explicit bundled Degree rewards isolated from the runtime snapshot", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const registryModulePath = require.resolve("../src/lib/mission/requirements/registry")
    try {
        const bundledRewards = bundledMissionContentRepository.table("mission_degree_reward.json")
        const runtimeRewards = {
            ...bundledRewards,
            3010: {
                ...bundledRewards["3010"],
                1: [[...bundledRewards["3010"]["1"][0]]],
            },
        }
        runtimeRewards[3010][1][0][1] = "81"
        const runtimeRepository = {
            info: () => ({ source: "mission-requirement-runtime-degree" }),
            table(tableName) {
                return tableName === "mission_degree_reward.json"
                    ? runtimeRewards
                    : bundledRuntimeTable(tableName)
            },
        }
        productionContentSnapshotProvider.snapshot = {
            cdn: {},
            archiveSources: { schemaVersion: 1, archives: [] },
            repository: runtimeRepository,
        }

        delete require.cache[registryModulePath]
        const isolatedRegistryModule = require(registryModulePath)
        const bundledCatalog = getMissionCatalog(bundledMissionContentRepository)
        assert.equal(bundledCatalog.getRewardStage(5, 3010, 1).targetProgress, 80)

        const requirement = isolatedRegistryModule
            .getMissionFactRequirementRegistry(bundledCatalog)
            .getRequirement(5, 3010)
        assert.equal(requirement.mode, "computed")
        assert.deepEqual(factIds(requirement), ["characters"])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
        delete require.cache[registryModulePath]
        require(registryModulePath)
    }
})

test("fails aggregate missions closed when any declared dependency is absent", () => {
    const catalog = getMissionCatalog()
    const missingDaily = forwardingCatalog(catalog, new Map(), {
        removedDefinitions: new Set(["2:4"]),
    })
    const missingAwake = forwardingCatalog(catalog, new Map(), {
        removedDefinitions: new Set(["9:13"]),
    })

    assertUnsupported(
        getMissionFactRequirementRegistry(missingDaily).getRequirement(2, 5),
        /dependency/i,
    )
    assertUnsupported(
        getMissionFactRequirementRegistry(missingAwake).getRequirement(9, 14),
        /dependency/i,
    )
})

test("keeps Category 4 compatible only with the current Computer definition", () => {
    const catalog = getMissionCatalog()
    const sameContent = forwardingCatalog(catalog)
    const source = catalog.getDefinition(4, 1500)
    const changedItem = withDefinitionField(source, 14, "999999")
    const changedCatalog = forwardingCatalog(
        catalog,
        new Map([["4:1500", changedItem]]),
    )

    assert.equal(getMissionFactRequirementRegistry(sameContent)
        .getRequirement(4, 1500).mode, "computed")
    assertUnsupported(
        getMissionFactRequirementRegistry(changedCatalog).getRequirement(4, 1500),
        /catalog|computer|definition/i,
    )
})

test("exports the Registry API and builds without DB, loader, or Session work", () => {
    const registry = getMissionFactRequirementRegistry()

    assert.equal(mission.getMissionFactRequirementRegistry, getMissionFactRequirementRegistry)
    assert.equal(databaseCalls, 0)
    assert.equal(registry.entries.some(entry => entry.category < 1 || entry.category > 10), false)
})
