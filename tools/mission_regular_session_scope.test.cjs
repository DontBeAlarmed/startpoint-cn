"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-regular-session-scope-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const characterDomain = require("../src/data/domains/character")
const degreeDomain = require("../src/data/domains/degree_battle_stats")
const equipmentDomain = require("../src/data/domains/equipment")
const itemDomain = require("../src/data/domains/item")
const battleDomain = require("../src/data/domains/mission_battle_facts")
const playerDomain = require("../src/data/domains/player")
const questDomain = require("../src/data/domains/quest")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()
let tracking = false
let evidence

function emptyEvidence() {
    return {
        domains: {
            player: 0,
            quest: 0,
            battle: 0,
            characters: 0,
            manaNodes: 0,
            equipment: 0,
            collectedAll: 0,
            collectedSelected: 0,
            degree: 0,
        },
        domainArgs: { quest: [], collectedSelected: [] },
        sql: {
            player: 0,
            quest: 0,
            battle: 0,
            characters: 0,
            bondTokens: 0,
            manaNodes: 0,
            equipment: 0,
            collected: 0,
            degree: 0,
        },
        statements: [],
    }
}

function instrumentDomain(module, method, key, argsKey) {
    const original = module[method]
    module[method] = (...args) => {
        if (tracking) {
            evidence.domains[key]++
            if (argsKey) evidence.domainArgs[argsKey].push(args.slice(1))
        }
        return original(...args)
    }
    return () => { module[method] = original }
}

const restoreDomains = [
    instrumentDomain(playerDomain, "getPlayerSync", "player"),
    instrumentDomain(questDomain, "getPlayerQuestProgressSync", "quest", "quest"),
    instrumentDomain(battleDomain, "getMissionBattleCountersSync", "battle"),
    instrumentDomain(characterDomain, "getPlayerCharactersSync", "characters"),
    instrumentDomain(characterDomain, "getPlayerCharactersManaNodesSync", "manaNodes"),
    instrumentDomain(equipmentDomain, "getPlayerEquipmentListSync", "equipment"),
    instrumentDomain(itemDomain, "getPlayerCollectedItemTotalsSync", "collectedAll"),
    instrumentDomain(
        itemDomain,
        "getPlayerCollectedItemTotalsByIdsSync",
        "collectedSelected",
        "collectedSelected",
    ),
    instrumentDomain(degreeDomain, "getDegreeBattleStatsSync", "degree"),
]

const originalPrepare = db.prepare.bind(db)
db.prepare = statement => {
    if (tracking) {
        const sql = String(statement)
        evidence.statements.push(sql)
        if (/\bFROM\s+players\s+WHERE\b/i.test(sql)) evidence.sql.player++
        if (/\bFROM\s+players_quest_progress\b/i.test(sql)) evidence.sql.quest++
        if (/\bFROM\s+players_mission_battle_counters\b/i.test(sql)) evidence.sql.battle++
        if (/\bFROM\s+players_characters\s+WHERE\b/i.test(sql)) evidence.sql.characters++
        if (/\bFROM\s+players_characters_bond_tokens\b/i.test(sql)) evidence.sql.bondTokens++
        if (/\bFROM\s+players_characters_mana_nodes\b/i.test(sql)) evidence.sql.manaNodes++
        if (/\bFROM\s+players_equipment\b/i.test(sql)) evidence.sql.equipment++
        if (/\bFROM\s+players_collected_items\b/i.test(sql)) evidence.sql.collected++
        if (/\bFROM\s+players_degree_battle_stats\b/i.test(sql)) evidence.sql.degree++
    }
    return originalPrepare(statement)
}

const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { PassComputer } = require("../src/lib/mission/pass")
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

function createSession(playerId, candidates) {
    return new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
}

function capture(run) {
    evidence = emptyEvidence()
    tracking = true
    try {
        const value = run()
        return { value, evidence }
    } finally {
        tracking = false
    }
}

function categoryCandidates(category, missionIds) {
    return missionIds.map(missionId => ({ category, missionId }))
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

test("player-only Regular mission reads one player row and no other planned domain", () => {
    const playerId = createPlayer("regular-player-only")
    const candidates = [
        { category: 1, missionId: 1 },
        { category: 2, missionId: 11 },
        { category: 3, missionId: 1204 },
        { category: 3, missionId: 1212 },
    ]
    const { evidence: reads } = capture(() => {
        const session = createSession(playerId, candidates)
        return RegularComputer.buildContextFromSession(session, 1, [1])
    })

    assert.deepEqual(reads.domains, {
        player: 1,
        quest: 0,
        battle: 0,
        characters: 0,
        manaNodes: 0,
        equipment: 0,
        collectedAll: 0,
        collectedSelected: 0,
        degree: 0,
    })
    assert.deepEqual(reads.sql, {
        player: 1,
        quest: 0,
        battle: 0,
        characters: 0,
        bondTokens: 0,
        manaNodes: 0,
        equipment: 0,
        collected: 0,
        degree: 0,
    })
})

test("quest-only Regular mission uses its one local section despite a foreign all-section fact", () => {
    const playerId = createPlayer("regular-quest-only")
    const { evidence: reads } = capture(() => {
        const session = createSession(playerId, [
            { category: 1, missionId: 10 },
            { category: 3, missionId: 1213 },
        ])
        return RegularComputer.buildContextFromSession(session, 1, [10])
    })

    assert.equal(reads.domains.player, 1)
    assert.equal(reads.domains.quest, 1)
    assert.deepEqual(reads.domainArgs.quest, [[[1]]])
    assert.equal(reads.sql.player, 1)
    assert.equal(reads.sql.quest, 1)
    assert.match(reads.statements.find(sql => /players_quest_progress/i.test(sql)), /section IN \(\?\)/)
    for (const key of ["battle", "characters", "manaNodes", "equipment", "degree"]) {
        assert.equal(reads.domains[key], 0, key)
    }
})

test("full Category 1 local plan invokes every required production loader at most once", () => {
    const playerId = createPlayer("regular-full")
    const missionIds = catalog.getMissionIds(1)
    const { evidence: reads } = capture(() => {
        const session = createSession(playerId, categoryCandidates(1, missionIds))
        return RegularComputer.buildContextFromSession(session, 1, missionIds)
    })

    assert.deepEqual(reads.domains, {
        player: 1,
        quest: 1,
        battle: 1,
        characters: 1,
        manaNodes: 1,
        equipment: 1,
        collectedAll: 0,
        collectedSelected: 1,
        degree: 1,
    })
    assert.deepEqual(reads.domainArgs.quest, [[[1, 3, 4, 15]]])
    assert.deepEqual(reads.domainArgs.collectedSelected, [[[100000]]])
    assert.equal(reads.sql.quest, 1)
    assert.equal(reads.sql.battle, 1)
    assert.equal(reads.sql.characters, 1)
    assert.equal(reads.sql.bondTokens, 1)
    assert.equal(reads.sql.manaNodes, 1)
    assert.equal(reads.sql.equipment, 1)
    assert.equal(reads.sql.collected, 1)
    assert.match(
        reads.statements.find(sql => /players_collected_items/i.test(sql)),
        /item_id IN \(\?\)/,
    )
    assert.equal(reads.sql.degree, 1)
})

test("persisted and unsupported Regular scope reads only the orchestrator player", () => {
    const playerId = createPlayer("regular-noncomputed")
    const missionIds = [4, 62]
    const { evidence: reads } = capture(() => {
        const session = createSession(playerId, categoryCandidates(1, missionIds))
        return RegularComputer.buildContextFromSession(session, 1, missionIds)
    })

    assert.equal(reads.domains.player, 1)
    assert.equal(reads.sql.player, 1)
    assert.equal(
        Object.entries(reads.domains).filter(([key]) => key !== "player")
            .reduce((total, [, count]) => total + count, 0),
        0,
    )
})

test("Category 1, 2 and 6 contexts reuse the settlement player and battle counters", () => {
    const playerId = createPlayer("regular-cross-category")
    const candidates = [
        { category: 1, missionId: 2 },
        { category: 2, missionId: 11 },
        { category: 6, missionId: 9 },
    ]
    const { evidence: reads } = capture(() => {
        const session = createSession(playerId, candidates)
        RegularComputer.buildContextFromSession(session, 1, [2])
        RegularComputer.buildContextFromSession(session, 2, [11])
        PassComputer.buildContextFromSession(session, 6, [9])
    })

    assert.equal(reads.domains.player, 1)
    assert.equal(reads.domains.battle, 1)
    assert.equal(reads.sql.player, 1)
    assert.equal(reads.sql.battle, 1)
})
