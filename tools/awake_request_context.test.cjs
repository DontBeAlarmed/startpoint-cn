"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-request-context-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const characterDomain = require("../src/data/domains/character")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const {
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const characterAssets = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2025-01-01T12:00:00.000Z")
const CHARACTER_A = 341005
const CHARACTER_B = 311002

function requestContextModule() {
    return require("../src/lib/mission/awake-request-context")
}

function missionApi() {
    return require("../src/lib/mission")
}

function createPlayer(label, characterIds = [CHARACTER_A]) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    for (const characterId of characterIds) {
        characterDomain.insertDefaultPlayerCharacterSync(playerId, characterId)
        db.prepare(`
            INSERT INTO players_character_quest_clears (
                player_id, character_id, clear_count, multi_count,
                leader_clear_count, leader_multi_count, leader_power_flip_count
            ) VALUES (?, ?, 5, 2, 3, 1, 0)
        `).run(playerId, characterId)
    }
    return playerId
}

function makeBaseReady(playerId, characterId) {
    const asset = characterAssets.getCharacterDataSync(characterId)
    characterDomain.updatePlayerCharacterSync(
        playerId,
        characterId,
        { exp: characterExpCaps[asset.rarity][0] },
    )
    characterDomain.insertPlayerCharacterManaNodesSync(
        playerId,
        characterId,
        Object.keys(characterAssets.getCharacterManaNodesSync(characterId, 1)).map(Number),
    )
}

function trackAwakeReads(run) {
    const originalPrepare = db.prepare.bind(db)
    const counts = {
        characters: 0,
        bondTokens: 0,
        manaNodes: 0,
        awakeLevels: 0,
        categoryProgress: 0,
        categoryStages: 0,
        unlocks: 0,
        total: 0,
    }
    db.prepare = sql => {
        const normalized = String(sql).replace(/\s+/g, " ").trim()
        if (/^SELECT /i.test(normalized)) counts.total++
        if (normalized.includes("FROM players_characters ")
            && !normalized.includes("players_characters_mana_nodes")) counts.characters++
        if (normalized.includes("FROM players_characters_bond_tokens")) counts.bondTokens++
        if (normalized.includes("FROM players_characters_mana_nodes")) {
            if (normalized.includes("awake_level")) counts.awakeLevels++
            else counts.manaNodes++
        }
        if (normalized.includes("FROM players_category_missions")
            && normalized.includes("id IN")) counts.categoryProgress++
        if (normalized.includes("FROM players_category_mission_stages")
            && normalized.includes("mission_id IN")) counts.categoryStages++
        if (normalized.includes("FROM players_character_awake_unlocks")) counts.unlocks++
        return originalPrepare(sql)
    }
    try {
        return { result: run(), counts }
    } finally {
        db.prepare = originalPrepare
    }
}

test("one context reads Awake snapshots once and evaluates only candidate dependencies", () => {
    const playerId = createPlayer("read-once", [CHARACTER_A, CHARACTER_B])
    makeBaseReady(playerId, CHARACTER_A)
    makeBaseReady(playerId, CHARACTER_B)
    updatePlayerCategoryMissionSync(playerId, 9, 3410051, 1)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, 3410051, true)

    const computer = require("../src/lib/mission/computer-awake").AwakeComputer
    const originalCompute = computer.compute
    const computedMissionIds = []
    computer.compute = function trackedCompute(missionId, ...args) {
        computedMissionIds.push(missionId)
        return originalCompute.call(this, missionId, ...args)
    }
    try {
        const { result, counts } = trackAwakeReads(() => {
            const context = requestContextModule().createAwakeRequestContext({
                playerId,
                evaluationTime,
                candidateCharacterIds: [CHARACTER_A],
            })
            const first = context.evaluate([CHARACTER_A])
            const repeated = context.evaluate([CHARACTER_A])
            assert.strictEqual(repeated, first)
            return context
        })

        assert.equal(counts.characters, 1)
        assert.equal(counts.bondTokens, 1)
        assert.equal(counts.manaNodes, 1)
        assert.equal(counts.awakeLevels, 1)
        assert.equal(counts.categoryProgress, 1)
        assert.equal(counts.categoryStages, 1)
        assert.equal(counts.unlocks, 1)
        assert.equal(result.playerId, playerId)
        assert.equal(computedMissionIds.length > 0, true)
        assert.equal(
            computedMissionIds.every(missionId => String(missionId).startsWith(String(CHARACTER_A))),
            true,
        )
    } finally {
        computer.compute = originalCompute
    }
})

test("context freezes identity, time, and candidate scope without refresh or global cache API", () => {
    const playerId = createPlayer("frozen-scope", [CHARACTER_A, CHARACTER_B])
    const mutableTime = new Date(evaluationTime)
    const first = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime: mutableTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    mutableTime.setUTCFullYear(2030)

    assert.equal(first.evaluationTime.toISOString(), evaluationTime.toISOString())
    assert.equal(Object.isFrozen(first), true)
    assert.equal("refresh" in first, false)
    assert.equal("cache" in requestContextModule(), false)
    assert.throws(() => first.evaluate([CHARACTER_B]), /outside.*scope/i)

    const second = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    assert.notStrictEqual(second, first)
    assert.notStrictEqual(second.resolver, first.resolver)
})

test("a context created before an authoritative write stays stale and a fresh context sees it", () => {
    const playerId = createPlayer("write-order")
    const asset = characterAssets.getCharacterDataSync(CHARACTER_A)
    characterDomain.updatePlayerCharacterSync(
        playerId,
        CHARACTER_A,
        { exp: characterExpCaps[asset.rarity][0] },
    )
    const stale = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    characterDomain.insertPlayerCharacterManaNodesSync(
        playerId,
        CHARACTER_A,
        Object.keys(characterAssets.getCharacterManaNodesSync(CHARACTER_A, 1)).map(Number),
    )

    assert.deepEqual(stale.evaluate(), [])
    const fresh = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    assert.equal(fresh.evaluate().length, 4)
})

test("a pre-write context cannot lazily refresh Session dependencies", () => {
    const playerId = createPlayer("session-write-order")
    makeBaseReady(playerId, CHARACTER_A)
    db.prepare(`
        UPDATE players_character_quest_clears
        SET clear_count = 0
        WHERE player_id = ? AND character_id = ?
    `).run(playerId, CHARACTER_A)
    const stale = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    db.prepare(`
        UPDATE players_character_quest_clears
        SET clear_count = 5
        WHERE player_id = ? AND character_id = ?
    `).run(playerId, CHARACTER_A)

    assert.equal(stale.evaluate().find(entry => entry.missionId === 3410052).progress, 0)
    const fresh = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    assert.equal(fresh.evaluate().find(entry => entry.missionId === 3410052).progress, 5)
})

test("identity mismatch and incomplete forged context fail closed", () => {
    const firstPlayerId = createPlayer("identity-a")
    const secondPlayerId = createPlayer("identity-b")
    const context = requestContextModule().createAwakeRequestContext({
        playerId: firstPlayerId,
        evaluationTime,
        candidateCharacterIds: [],
    })
    assert.throws(
        () => missionApi().reconcileAwakeUnlocks(secondPlayerId, [], context),
        /player.*mismatch/i,
    )
    assert.throws(
        () => missionApi().reconcileAwakeUnlocks(firstPlayerId, [], {
            playerId: firstPlayerId,
            evaluationTime,
            resolver: context.resolver,
            evaluate: () => [],
            readUnlocks: () => new Map(),
        }),
        /factory|context.*invalid/i,
    )
    const sparseCandidates = [CHARACTER_A]
    sparseCandidates.length = 2
    assert.throws(
        () => requestContextModule().createAwakeRequestContext({
            playerId: firstPlayerId,
            evaluationTime,
            candidateCharacterIds: sparseCandidates,
        }),
        /candidate.*complete|candidate.*array/i,
    )
})

test("candidate zero keeps cleanup semantics while one and many stay scoped", () => {
    const playerId = createPlayer("candidate-cardinality", [CHARACTER_A, CHARACTER_B])
    const characterAAsset = characterAssets.getCharacterDataSync(CHARACTER_A)
    characterDomain.updatePlayerCharacterSync(
        playerId,
        CHARACTER_A,
        { exp: characterExpCaps[characterAAsset.rarity][0] },
    )
    makeBaseReady(playerId, CHARACTER_B)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_A, 1, 1), true)
    characterDomain.updatePlayerCharacterSync(playerId, CHARACTER_A, { exp: 0 })

    const { counts } = trackAwakeReads(() => (
        missionApi().reconcileAwakeUnlocks(
            playerId,
            [],
            requestContextModule().createAwakeRequestContext({
                playerId,
                evaluationTime,
                candidateCharacterIds: [],
            }),
        )
    ))
    assert.equal(counts.total > 0, true)
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has(String(CHARACTER_A)), false)

    const one = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_B],
    }).evaluate()
    assert.equal(one.length, 4)
    assert.equal(one.every(entry => String(entry.missionId).startsWith(String(CHARACTER_B))), true)

    makeBaseReady(playerId, CHARACTER_A)
    const many = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A, CHARACTER_B, CHARACTER_A],
    }).evaluate()
    assert.equal(many.length, 8)
})

test("unknown character master data remains fail closed", () => {
    const playerId = createPlayer("unknown-master")
    makeBaseReady(playerId, CHARACTER_A)
    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    const originalGetCharacterDataSync = characterAssets.getCharacterDataSync
    characterAssets.getCharacterDataSync = characterId => (
        Number(characterId) === CHARACTER_A ? null : originalGetCharacterDataSync(characterId)
    )
    try {
        assert.deepEqual(context.evaluate(), [])
    } finally {
        characterAssets.getCharacterDataSync = originalGetCharacterDataSync
    }
})

test("summary and reconcile reuse Category 9 stages, progress, resolver, and unlock snapshot", () => {
    const playerId = createPlayer("summary-reuse")
    makeBaseReady(playerId, CHARACTER_A)
    updatePlayerCategoryMissionSync(playerId, 9, 3410051, 1)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, 3410051, true)

    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
    })
    const { result: summary, counts } = trackAwakeReads(() => {
        const firstSummary = missionApi().computeAwakeSummary(playerId, context)
        const reconciled = missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            firstSummary.activeMissionList.map(entry => ({
                missionId: entry.mission_id,
                progress: entry.progress_value,
            })),
            context.resolver,
            context,
        )
        assert.notStrictEqual(reconciled.all, context.readUnlocks())
        assert.deepEqual(context.readUnlocks(), new Map())
        return firstSummary
    })

    assert.equal(counts.categoryProgress, 0)
    assert.equal(counts.categoryStages, 0)
    assert.equal(counts.characters, 0)
    assert.equal(counts.manaNodes, 0)
    assert.equal(counts.awakeLevels, 0)
    assert.equal(counts.unlocks, 0)
    const mission = summary.activeMissionList.find(entry => entry.mission_id === 3410051)
    assert.deepEqual(mission.stages, [{ stage: 1, received: true }])
})

test("outer rollback cannot refresh a context unlock snapshot", () => {
    const playerId = createPlayer("outer-rollback-snapshot")
    makeBaseReady(playerId, CHARACTER_A)
    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    const rollback = new Error("rollback after awake reconcile")
    let reconciledAll

    assert.throws(() => db.transaction(() => {
        reconciledAll = missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            [
                { missionId: 3410051, progress: 1 },
                { missionId: 3410052, progress: 5 },
                { missionId: 3410053, progress: 5 },
                { missionId: 3410054, progress: 3 },
            ],
            context.resolver,
            context,
        ).all
        assert.deepEqual(reconciledAll.get(String(CHARACTER_A)), { 1: 1 })
        throw rollback
    })(), error => error === rollback)

    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has(String(CHARACTER_A)), false)
    assert.deepEqual(context.readUnlocks(), new Map())
    assert.deepEqual(reconciledAll.get(String(CHARACTER_A)), { 1: 1 })
})

test("callers cannot mutate a context unlock snapshot through readUnlocks", () => {
    const playerId = createPlayer("readonly-unlock-snapshot")
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_A, 1, 1), true)
    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [],
    })
    const exposed = context.readUnlocks()
    exposed.set("999999", { 1: 9 })
    exposed.get(String(CHARACTER_A))[1] = 7

    assert.deepEqual(context.readUnlocks(), new Map([
        [String(CHARACTER_A), { 1: 1 }],
    ]))
})

test("legacy unlock snapshot is read inside the reconcile transaction", () => {
    const playerId = createPlayer("legacy-unlock-read-boundary")
    const resolver = missionApi().createCharacterAwakeEligibilityResolver(
        playerId,
        evaluationTime,
    )
    const originalPrepare = db.prepare.bind(db)
    const originalTransactionMethod = db.transaction
    const originalTransaction = db.transaction.bind(db)
    const readDepths = []
    let transactionDepth = 0

    db.prepare = sql => {
        const normalized = String(sql).replace(/\s+/g, " ").trim()
        if (normalized.includes("FROM players_character_awake_unlocks")) {
            readDepths.push(transactionDepth)
        }
        return originalPrepare(sql)
    }
    db.transaction = callback => originalTransaction((...args) => {
        transactionDepth++
        try {
            return callback(...args)
        } finally {
            transactionDepth--
        }
    })
    try {
        missionApi().reconcileAwakeUnlocksFromProgress(playerId, [], resolver)
    } finally {
        db.prepare = originalPrepare
        db.transaction = originalTransactionMethod
    }

    assert.deepEqual(readDepths, [1])
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
