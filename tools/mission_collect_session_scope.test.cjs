"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-session-scope-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const itemDomain = require("../src/data/domains/item")
const playerDomain = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()
let tracking = false
let reads

function instrument(module, method, key) {
    const original = module[method]
    module[method] = (...args) => {
        if (tracking) {
            reads[key]++
            if (key === "selected") reads.selections.push(args[1])
        }
        return original(...args)
    }
    return () => { module[method] = original }
}

const restoreDomains = [
    instrument(playerDomain, "getPlayerSync", "player"),
    instrument(itemDomain, "getPlayerCollectedItemTotalsSync", "all"),
    instrument(itemDomain, "getPlayerCollectedItemTotalsByIdsSync", "selected"),
]
const originalPrepare = db.prepare.bind(db)
db.prepare = statement => {
    if (tracking && /\bFROM\s+players_collected_items\b/i.test(String(statement))) reads.sql++
    return originalPrepare(statement)
}

const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { CollectComputer } = require("../src/lib/mission/collect-progress")
const { RegularComputer } = require("../src/lib/mission/computer-regular")

const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const catalog = getMissionCatalog()
const requirementRegistry = getMissionFactRequirementRegistry(catalog)

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return playerDomain.insertDefaultPlayerSync(account.id).id
}

function createSession(playerId, candidates, registry = requirementRegistry) {
    return new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
}

function capture(run) {
    reads = { player: 0, all: 0, selected: 0, selections: [], sql: 0 }
    tracking = true
    try {
        return { value: run(), reads }
    } finally {
        tracking = false
    }
}

test.after(() => {
    tracking = false
    db.prepare = originalPrepare
    for (const restore of restoreDomains.reverse()) restore()
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("single Collect selector stays local while Category 1 reuses player cache", () => {
    const playerId = createPlayer("collect-local")
    const session = createSession(playerId, [
        { category: 4, missionId: 1500 },
        { category: 1, missionId: 66 },
        { category: 5, missionId: 41000 },
    ])
    const { reads: evidence } = capture(() => {
        CollectComputer.buildContextFromSession(session, 4, [1500])
        RegularComputer.buildContextFromSession(session, 1, [66])
    })

    assert.deepEqual(evidence, {
        player: 1,
        all: 0,
        selected: 2,
        selections: [[80001], [100000]],
        sql: 2,
    })
})

test("multiple Collect missions merge unique item selectors into one query", () => {
    const playerId = createPlayer("collect-merged")
    const missionIds = [1500, 1574, 1501]
    const { reads: evidence } = capture(() => {
        const session = createSession(
            playerId,
            missionIds.map(missionId => ({ category: 4, missionId })),
        )
        CollectComputer.buildContextFromSession(session, 4, missionIds)
    })

    assert.equal(evidence.player, 1)
    assert.equal(evidence.all, 0)
    assert.equal(evidence.selected, 1)
    assert.deepEqual(evidence.selections, [[80001, 80002]])
    assert.equal(evidence.sql, 1)
})

test("persisted and unsupported Collect requirements do not load collected items", () => {
    const playerId = createPlayer("collect-noncomputed")
    const persisted = Object.freeze({
        mode: "persisted",
        facts: Object.freeze([{
            kind: "collectedItems",
            itemIds: Object.freeze([80001]),
        }]),
        missionDependencies: Object.freeze([]),
    })
    const unsupported = Object.freeze({
        mode: "unsupported",
        facts: Object.freeze([{
            kind: "collectedItems",
            itemIds: Object.freeze([80002]),
        }]),
        missionDependencies: Object.freeze([]),
        reason: "Injected unsupported requirement with stray facts.",
    })
    const registry = {
        size: 2,
        entries: [],
        getRequirement(category, missionId) {
            if (category !== 4) return undefined
            return missionId === 1500 ? persisted : unsupported
        },
        getMissionsForFact() { return [] },
    }
    const { reads: evidence } = capture(() => {
        const session = createSession(playerId, [
            { category: 4, missionId: 1500 },
            { category: 4, missionId: 1653 },
        ], registry)
        CollectComputer.buildContextFromSession(session, 4, [1500, 1653])
    })

    assert.deepEqual(evidence, {
        player: 1,
        all: 0,
        selected: 0,
        selections: [],
        sql: 0,
    })
})

test("Collect Session context enforces category and candidate boundaries", () => {
    const playerId = createPlayer("collect-boundaries")
    const session = createSession(playerId, [{ category: 4, missionId: 1500 }])

    assert.throws(
        () => CollectComputer.buildContextFromSession(session, 1, [1500]),
        /only supports category 4/i,
    )
    assert.throws(
        () => CollectComputer.buildContextFromSession(session, 4, [1574]),
        /outside the evaluation Session candidates/i,
    )
})

test("all bundled unsupported Category 4 candidates load no collected items", () => {
    const playerId = createPlayer("collect-all-unsupported")
    const missionIds = catalog.getMissionIds(4).filter(missionId =>
        requirementRegistry.getRequirement(4, missionId).mode === "unsupported")
    const { reads: evidence } = capture(() => {
        const session = createSession(
            playerId,
            missionIds.map(missionId => ({ category: 4, missionId })),
        )
        CollectComputer.buildContextFromSession(session, 4, missionIds)
    })

    assert.equal(missionIds.length, 718)
    assert.equal(evidence.player, 1)
    assert.equal(evidence.all, 0)
    assert.equal(evidence.selected, 0)
    assert.equal(evidence.sql, 0)
})
