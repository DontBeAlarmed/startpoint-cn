"use strict"

require("ts-node/register/transpile-only")

const { productionContentSnapshotProvider } = require("../../src/content/runtime/content-snapshot")
const { MissionEvaluationSession } = require("../../src/lib/mission/evaluation-session")
const { MissionFactLoaderRegistry } = require("../../src/lib/mission/fact-loaders")
const { getFactKeyId } = require("../../src/lib/mission/facts/fact-key")
const { bundledMissionContentRepository } = require("../../src/lib/mission/mission-catalog-source")
const { getMissionCatalog } = require("../../src/lib/mission/mission-catalog")
const { getMissionFactRequirementRegistry } = require("../../src/lib/mission/requirements/registry")
const { DegreeComputer, computeDegreeProgress } = require("../../src/lib/mission/computer-degree")
const { buildDegreeRuleCatalog } = require("../../src/lib/mission/degree-rule-catalog")
const {
    EMPTY_BATTLE_COUNTERS,
    EMPTY_DEGREE_BATTLE_STATS,
} = require("../../src/lib/mission/degree-state-derivation")

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function repositoryWith(overrides, source = "degree-session-custom") {
    return {
        info: () => ({
            source: "release",
            assetVersion: source,
            generatorVersion: 1,
            releaseDigest: `sha256:${source}`,
            contentDigest: `sha256:${source}`,
            multiBattleContentDigest: `sha256:${source}`,
        }),
        table(tableName) {
            return Object.hasOwn(overrides, tableName)
                ? overrides[tableName]
                : bundledMissionContentRepository.table(tableName)
        },
    }
}

function installGlobalRepository(repository) {
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: repository.info().assetVersion },
        archiveSources: { schemaVersion: 1, archives: [] },
        repository,
    }
}

function player(rankPoint = 0) {
    return {
        id: 99,
        rankPoint,
        totalStaminaUsed: 0,
        totalDashes: 0,
        maxComboAchieved: 0,
        totalLoginDays: 0,
    }
}

function customDegreeCatalog(mutateDefinitions, mutateRewards = () => undefined) {
    const definitions = clone(bundledMissionContentRepository.table("mission_degree.json"))
    const rewards = clone(bundledMissionContentRepository.table("mission_degree_reward.json"))
    mutateDefinitions(definitions)
    mutateRewards(rewards)
    return getMissionCatalog(repositoryWith({
        "mission_degree.json": definitions,
        "mission_degree_reward.json": rewards,
    }))
}

function createSession(catalog, missionIds, facts, calls = []) {
    const loaders = new MissionFactLoaderRegistry()
    for (const [kind, value] of Object.entries(facts)) {
        loaders.register(kind, ({ key }) => {
            calls.push(key)
            return value
        })
    }
    return new MissionEvaluationSession({
        playerId: 99,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: missionIds.map(missionId => ({ category: 5, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
}

function character(overrides = {}) {
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: new Date(0),
        updateTime: new Date(0),
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [],
        ...overrides,
    }
}

function allFacts(overrides = {}) {
    return {
        player: player(),
        characters: {},
        characterManaNodes: {},
        missionBattleCounters: { ...EMPTY_BATTLE_COUNTERS },
        degreeBattleStats: { ...EMPTY_DEGREE_BATTLE_STATS },
        questProgress: {},
        shopPurchases: {},
        collectedItems: {},
        equipment: {},
        ...overrides,
    }
}

function assertLoaderKeys(assert, catalog, missionIds, expectedKeys) {
    const calls = []
    const session = createSession(catalog, missionIds, allFacts(), calls)
    DegreeComputer.buildContextFromSession(session, 5, missionIds)
    const ids = calls.map(getFactKeyId)
    assert.deepEqual(ids.sort(), [...expectedKeys].sort())
    assert.equal(new Set(ids).size, calls.length, "每个合并 FactKey 最多读取一次")
}

module.exports = {
    DegreeComputer,
    EMPTY_BATTLE_COUNTERS,
    EMPTY_DEGREE_BATTLE_STATS,
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    allFacts,
    assertLoaderKeys,
    buildDegreeRuleCatalog,
    bundledMissionContentRepository,
    character,
    clone,
    computeDegreeProgress,
    createSession,
    customDegreeCatalog,
    getFactKeyId,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
    installGlobalRepository,
    player,
    productionContentSnapshotProvider,
    repositoryWith,
}
