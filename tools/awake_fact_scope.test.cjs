"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-fact-scope-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerCharacterSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { publishAwakeCharacterListBestEffort } = require(
    "../src/lib/mission/awake-best-effort-context",
)
const { createAwakeRequestContext } = require("../src/lib/mission/awake-request-context")
const scope = require("../src/lib/mission/awake-request-context-scope")
const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const {
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission/requirements/registry")

let database

function registryEntry(category, missionId, dependencies = []) {
    return {
        category,
        missionId,
        requirement: {
            mode: "computed",
            facts: [],
            missionDependencies: dependencies.map(([dependencyCategory, dependencyMissionId]) => ({
                category: dependencyCategory,
                missionId: dependencyMissionId,
            })),
        },
    }
}

function customRegistry(entries, reverseRefs = [{ category: 9, missionId: 100 }]) {
    const requirements = new Map(entries.map(entry => [
        `${entry.category}:${entry.missionId}`,
        entry.requirement,
    ]))
    return {
        size: entries.length,
        entries,
        getRequirement(category, missionId) {
            return requirements.get(`${category}:${missionId}`)
        },
        getMissionsForFact() {
            return reverseRefs
        },
    }
}

function createPlayer(label, characterIds = []) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    for (const characterId of characterIds) {
        insertDefaultPlayerCharacterSync(playerId, characterId)
    }
    return playerId
}

test.before(() => {
    database = data.initializeDatabase()
})

test.after(() => {
    if (database?.open) database.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("reverse FactKey seeds select only bounded Category 9 Awake missions", () => {
    const registry = getMissionFactRequirementRegistry(getMissionCatalog())
    const directStoryMissions = registry.getMissionsForFact({
        kind: "questProgress",
        sections: [3],
    }).filter(ref => ref.category === 9).map(ref => ref.missionId)
    const playerMissions = scope.collectAwakeMissionIdsFromSeeds({
        invalidatedFactKeys: [{ kind: "player" }],
        directMissionIds: [],
    }, registry)
    const storyMissions = scope.collectAwakeMissionIdsFromSeeds({
        invalidatedFactKeys: [{ kind: "questProgress", sections: [3] }],
        directMissionIds: [],
    }, registry)

    assert.deepEqual(playerMissions, [2630022, 2630024])
    assert.equal(directStoryMissions.length, 19)
    assert.equal(directStoryMissions.includes(2630021), true)
    assert.equal(directStoryMissions.every(missionId => storyMissions.includes(missionId)), true)
    assert.equal(storyMissions.includes(2630024), true)
    assert.equal(storyMissions.length, 37)
    assert.equal(storyMissions.length - directStoryMissions.length, 18)
    assert.equal(Object.isFrozen(playerMissions), true)
    assert.equal(Object.isFrozen(storyMissions), true)
})

test("walks upward through multiple and nested Category 9 parents for all seed kinds", () => {
    const entries = [
        registryEntry(9, 100),
        registryEntry(9, 200, [[9, 100]]),
        registryEntry(9, 300, [[9, 100]]),
        registryEntry(9, 400, [[9, 200]]),
        registryEntry(9, 900),
        registryEntry(9, 901, [[9, 900]]),
    ]

    assert.deepEqual(scope.collectAwakeMissionIdsFromSeeds({
        invalidatedFactKeys: [{ kind: "player" }],
        directMissionIds: [900],
    }, customRegistry(entries)), [100, 200, 300, 400, 900, 901])
})

test("adds parents without adding unrelated siblings or following cross-category edges", () => {
    const entries = [
        registryEntry(9, 100),
        registryEntry(9, 250, [[9, 100], [9, 999]]),
        registryEntry(9, 500, [[9, 999]]),
        registryEntry(5, 600, [[9, 100]]),
        registryEntry(9, 601, [[5, 100]]),
    ]

    assert.deepEqual(scope.collectAwakeMissionIdsFromSeeds({
        invalidatedFactKeys: [{ kind: "player" }],
        directMissionIds: [],
    }, customRegistry(entries)), [100, 250])
})

test("terminates cycles with stable deduplicated results independent of entry order", () => {
    const entries = [
        registryEntry(9, 100),
        registryEntry(9, 200, [[9, 100]]),
        registryEntry(9, 300, [[9, 200], [9, 400]]),
        registryEntry(9, 400, [[9, 300]]),
    ]
    const seeds = {
        invalidatedFactKeys: [{ kind: "player" }, { kind: "player" }],
        directMissionIds: [100, 100],
    }
    const forward = scope.collectAwakeMissionIdsFromSeeds(
        seeds,
        customRegistry(entries, [
            { category: 9, missionId: 100 },
            { category: 9, missionId: 100 },
        ]),
    )
    const reversed = scope.collectAwakeMissionIdsFromSeeds(
        seeds,
        customRegistry([...entries].reverse(), [
            { category: 9, missionId: 100 },
            { category: 9, missionId: 100 },
        ]),
    )

    assert.deepEqual(forward, [100, 200, 300, 400])
    assert.deepEqual(reversed, forward)
    assert.equal(Object.isFrozen(forward), true)
    assert.equal(Object.isFrozen(reversed), true)
})

test("normalizes, deduplicates, and freezes FactKeys while sorting direct mission seeds", () => {
    const facts = scope.normalizeAwakeInvalidatedFactKeys([
        { kind: "player" },
        { kind: "questProgress", sections: [3, 1, 3] },
        { kind: "player" },
        { kind: "questProgress", sections: [1, 3] },
    ])
    const directMissionIds = scope.normalizeAwakeDirectMissionIds([
        2630024,
        2630022,
        2630024,
    ])

    assert.deepEqual(facts, [
        { kind: "player" },
        { kind: "questProgress", sections: [1, 3] },
    ])
    assert.deepEqual(directMissionIds, [2630022, 2630024])
    assert.equal(Object.isFrozen(facts), true)
    assert.equal(Object.isFrozen(facts[0]), true)
    assert.equal(Object.isFrozen(facts[1]), true)
    assert.equal(Object.isFrozen(facts[1].sections), true)
    assert.equal(Object.isFrozen(directMissionIds), true)
})

test("ignores non-Category-9 reverse references and deduplicates direct hits", () => {
    const registry = customRegistry([], [
        { category: 5, missionId: 7000 },
        { category: 9, missionId: 2630022 },
        { category: 9, missionId: 2630022 },
    ])

    assert.deepEqual(scope.collectAwakeMissionIdsFromSeeds({
        invalidatedFactKeys: [{ kind: "player" }],
        directMissionIds: [3410054, 2630022],
    }, registry), [2630022, 3410054])
})

test("rejects sparse or malformed FactKey and direct mission seed inputs", () => {
    const sparseFacts = [{ kind: "player" }]
    sparseFacts.length = 2
    const sparseSections = [3]
    sparseSections.length = 2
    const sparseMissionIds = [2630022]
    sparseMissionIds.length = 2

    assert.throws(
        () => scope.normalizeAwakeInvalidatedFactKeys({ kind: "player" }),
        /FactKey|array/i,
    )
    assert.throws(
        () => scope.normalizeAwakeInvalidatedFactKeys(sparseFacts),
        /FactKey|complete|array/i,
    )
    assert.throws(
        () => scope.normalizeAwakeInvalidatedFactKeys([{ kind: "unknown" }]),
        /FactKey|unknown/i,
    )
    assert.throws(
        () => scope.normalizeAwakeInvalidatedFactKeys([
            { kind: "questProgress", sections: sparseSections },
        ]),
        /sections|own enumerable data property/i,
    )
    assert.throws(
        () => scope.normalizeAwakeDirectMissionIds({ 0: 2630022, length: 1 }),
        /mission|array/i,
    )
    assert.throws(
        () => scope.normalizeAwakeDirectMissionIds(sparseMissionIds),
        /mission|complete|array/i,
    )
    for (const missionId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2630022"]) {
        assert.throws(
            () => scope.normalizeAwakeDirectMissionIds([missionId]),
            /mission.*positive safe integers/i,
        )
    }
})

test("FactKey-derived mission characters enter the effective scoped snapshot", () => {
    const playerId = createPlayer("derived-character", [341005, 263002])
    const context = createAwakeRequestContext({
        playerId,
        evaluationTime: new Date("2025-01-01T12:00:00.000Z"),
        candidateCharacterIds: [341005],
        invalidatedFactKeys: [{ kind: "player" }],
    })

    assert.deepEqual(
        Object.keys(context.resolver.characters).map(Number).sort((left, right) => left - right),
        [263002, 341005],
    )
})

test("best-effort scope creation failure preserves the original flattened character list", () => {
    const playerId = createPlayer("best-effort-failure")
    const original = [{ character_id: 341005, entry_count: 1 }]
    const errors = []
    const originalConsoleError = console.error
    console.error = (...args) => errors.push(args)
    try {
        assert.deepEqual(publishAwakeCharacterListBestEffort(
            playerId,
            [],
            [original],
            { invalidatedFactKeys: [{ kind: "unknown" }] },
        ), original)
    } finally {
        console.error = originalConsoleError
    }
    assert.equal(errors.length, 1)
})
