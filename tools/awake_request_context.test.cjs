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
const characterAwakeDomain = require("../src/data/domains/character_awake")
const characterClearDomain = require("../src/data/domains/character_clear")
const partyCoClearDomain = require("../src/data/domains/party_co_clear")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = characterAwakeDomain
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

function requestContextScopeModule() {
    return require("../src/lib/mission/awake-request-context-scope")
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

test("oversized candidate scope fails closed before scoped SQL readers", () => {
    const playerId = createPlayer("oversized-candidate-scope")
    const oversizedCandidates = Array.from({ length: 10001 }, (_, index) => 900000 + index)

    assert.throws(
        () => requestContextModule().createAwakeRequestContext({
            playerId,
            evaluationTime,
            candidateCharacterIds: oversizedCandidates,
        }),
        /Awake candidate scope exceeds bounded character-id budget/i,
    )
})

test("candidate and existing unlock IDs share one bounded scope budget after deduplication", () => {
    const scope = requestContextScopeModule()
    const candidateIds = Array.from({ length: 5001 }, (_, index) => 100000 + index)
    const existingUnlockIds = Array.from({ length: 5001 }, (_, index) => 105000 + index)
    existingUnlockIds[0] = candidateIds[0]

    assert.throws(
        () => scope.mergeAwakeScopedCharacterIds(candidateIds, existingUnlockIds),
        /Awake candidate scope exceeds bounded character-id budget/i,
    )

    const withinBudget = scope.mergeAwakeScopedCharacterIds(
        [1, 2, 2, 3],
        [3, 4, 4],
    )
    assert.deepEqual(withinBudget, [1, 2, 3, 4])
})

test("resolver facts, time, and character master readiness stay frozen", () => {
    const playerId = createPlayer("stable-resolver")
    makeBaseReady(playerId, CHARACTER_A)
    const mutableEvaluationTime = new Date(evaluationTime)
    const snapshot = {
        characters: characterDomain.getPlayerCharactersSync(playerId),
        manaNodes: characterDomain.getPlayerCharactersManaNodesSync(playerId),
        manaNodeAwakeLevels: characterDomain
            .getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
        evaluationTime: mutableEvaluationTime,
    }
    const resolver = missionApi().createCharacterAwakeEligibilityResolverFromSnapshot(snapshot)
    const exposedCharacters = resolver.characters
    const exposedManaNodes = resolver.manaNodes
    const exposedAwakeLevels = resolver.manaNodeAwakeLevels
    const exposedEvaluationTime = resolver.evaluationTime

    snapshot.characters[String(CHARACTER_A)].exp = 0
    snapshot.manaNodes[String(CHARACTER_A)].length = 0
    snapshot.manaNodeAwakeLevels[String(CHARACTER_A)][999999] = 9
    mutableEvaluationTime.setUTCFullYear(2035)
    exposedCharacters[String(CHARACTER_A)].exp = 0
    exposedManaNodes[String(CHARACTER_A)].length = 0
    exposedAwakeLevels[String(CHARACTER_A)][999998] = 8
    exposedEvaluationTime.setUTCFullYear(2036)

    assert.equal(resolver.getBaseReadiness(CHARACTER_A), "ready")
    assert.equal(resolver.hasPositiveManaNodeAwakeLevel(CHARACTER_A), false)
    assert.equal(resolver.isNewUnlockEligible(CHARACTER_A, 3410051), true)
    assert.equal(resolver.evaluationTime.toISOString(), evaluationTime.toISOString())

    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    const originalGetCharacterDataSync = characterAssets.getCharacterDataSync
    const originalGetCharacterManaNodesSync = characterAssets.getCharacterManaNodesSync
    characterAssets.getCharacterDataSync = characterId => (
        Number(characterId) === CHARACTER_A ? null : originalGetCharacterDataSync(characterId)
    )
    characterAssets.getCharacterManaNodesSync = (characterId, boardIndex) => (
        Number(characterId) === CHARACTER_A
            ? null
            : originalGetCharacterManaNodesSync(characterId, boardIndex)
    )
    try {
        assert.equal(context.evaluate().length, 4)
    } finally {
        characterAssets.getCharacterDataSync = originalGetCharacterDataSync
        characterAssets.getCharacterManaNodesSync = originalGetCharacterManaNodesSync
    }

    characterAssets.getCharacterDataSync = characterId => (
        Number(characterId) === CHARACTER_A ? null : originalGetCharacterDataSync(characterId)
    )
    let unknownContext
    try {
        unknownContext = requestContextModule().createAwakeRequestContext({
            playerId,
            evaluationTime,
            candidateCharacterIds: [CHARACTER_A],
        })
    } finally {
        characterAssets.getCharacterDataSync = originalGetCharacterDataSync
    }
    assert.deepEqual(unknownContext.evaluate(), [])
})

test("publication projection failures roll back strict and best-effort unlock writes", () => {
    const playerId = createPlayer("projection-rollback")
    makeBaseReady(playerId, CHARACTER_A)
    db.prepare(`
        UPDATE players_characters
        SET join_time = 'invalid-awake-projection-date'
        WHERE player_id = ? AND id = ?
    `).run(playerId, CHARACTER_A)
    const existing = [{ character_id: CHARACTER_A, stack: 4 }]
    const projectionError = new Error("invalid joinTime during Awake response projection")
    const originalGetUTCFullYear = Date.prototype.getUTCFullYear
    const originalConsoleError = console.error
    let loggedError

    Date.prototype.getUTCFullYear = function getUTCFullYearWithValidation() {
        if (Number.isNaN(this.getTime())) throw projectionError
        return originalGetUTCFullYear.call(this)
    }
    console.error = (...args) => {
        loggedError = args
    }
    try {
        assert.strictEqual(
            missionApi().reconcileAwakeUnlockCharacterListBestEffort(
                playerId,
                existing,
                { candidateCharacterIds: [CHARACTER_A] },
            ),
            existing,
        )
        assert.strictEqual(loggedError?.[1], projectionError)
        assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has(String(CHARACTER_A)), false)

        assert.throws(
            () => missionApi().reconcileAwakeUnlockCharacterListStrict(
                playerId,
                existing,
                { candidateCharacterIds: [CHARACTER_A] },
            ),
            error => error === projectionError,
        )
        assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has(String(CHARACTER_A)), false)
    } finally {
        Date.prototype.getUTCFullYear = originalGetUTCFullYear
        console.error = originalConsoleError
    }
})

test("context reconcile rejects out-of-scope progress and every second write attempt", () => {
    const playerId = createPlayer("write-lifecycle")
    makeBaseReady(playerId, CHARACTER_A)
    const progress = [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410052, progress: 5 },
        { missionId: 3410053, progress: 5 },
        { missionId: 3410054, progress: 3 },
    ]
    const emptyScope = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [],
    })
    assert.throws(
        () => missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            progress,
            emptyScope.resolver,
            emptyScope,
        ),
        /outside.*scope/i,
    )
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).size, 0)

    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    assert.equal(context.evaluate().length, 4)
    assert.deepEqual(
        missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            progress,
            context.resolver,
            context,
        ).all,
        new Map([[String(CHARACTER_A), { 1: 1 }]]),
    )
    assert.throws(
        () => missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            progress,
            context.resolver,
            context,
        ),
        /already.*consumed|write.*once/i,
    )
    assert.deepEqual(
        getPlayerCharacterAwakeUnlocksSync(playerId),
        new Map([[String(CHARACTER_A), { 1: 1 }]]),
    )
})

test("a failed context reconcile still consumes its write lifecycle", () => {
    const playerId = createPlayer("failed-write-lifecycle")
    makeBaseReady(playerId, CHARACTER_A)
    const context = requestContextModule().createAwakeRequestContext({
        playerId,
        evaluationTime,
        candidateCharacterIds: [CHARACTER_A],
    })
    const progress = [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410052, progress: 5 },
        { missionId: 3410053, progress: 5 },
        { missionId: 3410054, progress: 3 },
    ]
    const writeError = new Error("synthetic Awake unlock write failure")
    const originalUpsert = characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync
    characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync = () => {
        throw writeError
    }
    try {
        assert.throws(
            () => missionApi().reconcileAwakeUnlocksFromProgress(
                playerId,
                progress,
                context.resolver,
                context,
            ),
            error => error === writeError,
        )
    } finally {
        characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync = originalUpsert
    }
    assert.throws(
        () => missionApi().reconcileAwakeUnlocksFromProgress(
            playerId,
            progress,
            context.resolver,
            context,
        ),
        /already.*consumed|write.*once/i,
    )
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).size, 0)
})

test("legacy resolver compatibility does not rely on an evaluate-shaped context check", () => {
    const playerId = createPlayer("legacy-resolver")
    makeBaseReady(playerId, CHARACTER_A)
    const resolver = missionApi().createCharacterAwakeEligibilityResolver(playerId, evaluationTime)
    const reconciled = missionApi().reconcileAwakeUnlocks(playerId, [CHARACTER_A], resolver)
    assert.deepEqual(reconciled.all, new Map([[String(CHARACTER_A), { 1: 1 }]]))

    const resolverWithEvaluate = {
        characters: resolver.characters,
        manaNodes: resolver.manaNodes,
        manaNodeAwakeLevels: resolver.manaNodeAwakeLevels,
        evaluationTime: resolver.evaluationTime,
        getBaseReadiness: resolver.getBaseReadiness,
        hasPositiveManaNodeAwakeLevel: resolver.hasPositiveManaNodeAwakeLevel,
        isNewUnlockEligible: resolver.isNewUnlockEligible,
        evaluate() {
            throw new Error("legacy resolver evaluate method must not be called")
        },
    }
    const summary = missionApi().computeAwakeSummary(playerId, resolverWithEvaluate)
    assert.equal(summary.activeMissionList.length, 4)
})

test("Awake requirement collection fails closed for facts its context does not consume", () => {
    const unsupportedFactLists = [
        [{ kind: "items" }],
        [{ kind: "characterManaNodes" }],
        [{ kind: "categoryMissionProgress", category: 8, missionIds: [9001] }],
        [
            { kind: "categoryMissionProgress", category: 9, missionIds: [3410052] },
            { kind: "items" },
        ],
    ]
    for (const facts of unsupportedFactLists) {
        const registry = {
            getRequirement(category, missionId) {
                if (category !== 9 || missionId !== 3410051) return undefined
                return {
                    mode: "computed",
                    facts,
                    missionDependencies: [],
                }
            },
        }
        assert.deepEqual(
            requestContextModule().collectSupportedAwakeMissionIds([3410051], registry),
            { candidates: [], closure: [] },
        )
    }
})

test("character clear reader scopes rows by normalized character IDs and skips empty SQL", () => {
    const playerId = createPlayer("scoped-clear-reader", [CHARACTER_A, CHARACTER_B])
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 999901, 99, 98, 97, 96, 95)
    `).run(playerId)
    const originalPrepare = db.prepare.bind(db)
    let prepareCalls = 0
    db.prepare = sql => {
        prepareCalls++
        return originalPrepare(sql)
    }
    try {
        assert.deepEqual(characterClearDomain.getPlayerCharacterClearsByIdsSync(playerId, []), {})
        assert.equal(prepareCalls, 0)
        assert.deepEqual(
            characterClearDomain.getPlayerCharacterClearsByIdsSync(
                playerId,
                [CHARACTER_B, CHARACTER_A, CHARACTER_B],
            ),
            {
                [CHARACTER_A]: {
                    clear_count: 5,
                    multi_count: 2,
                    leader_clear_count: 3,
                    leader_multi_count: 1,
                    leader_power_flip_count: 0,
                },
                [CHARACTER_B]: {
                    clear_count: 5,
                    multi_count: 2,
                    leader_clear_count: 3,
                    leader_multi_count: 1,
                    leader_power_flip_count: 0,
                },
            },
        )
        assert.equal(prepareCalls, 1)
    } finally {
        db.prepare = originalPrepare
    }
})

test("party co-clear reader scopes rows when either character matches and skips empty SQL", () => {
    const playerId = createPlayer("scoped-co-clear-reader")
    db.prepare(`
        INSERT INTO players_party_member_co_clears (
            player_id, char_id_a, char_id_b, co_clear_count
        ) VALUES (?, ?, 777701, 4), (?, 777702, ?, 5), (?, 777703, 777704, 99)
    `).run(playerId, CHARACTER_A, playerId, CHARACTER_A, playerId)
    const originalPrepare = db.prepare.bind(db)
    let prepareCalls = 0
    db.prepare = sql => {
        prepareCalls++
        return originalPrepare(sql)
    }
    try {
        assert.deepEqual(
            partyCoClearDomain.getPlayerPartyCoClearCountersByCharacterIdsSync(playerId, []),
            [],
        )
        assert.equal(prepareCalls, 0)
        assert.deepEqual(
            partyCoClearDomain.getPlayerPartyCoClearCountersByCharacterIdsSync(
                playerId,
                [CHARACTER_A, CHARACTER_A],
            ),
            [
                { char_id_a: CHARACTER_A, char_id_b: 777701, co_clear_count: 4 },
                { char_id_a: 777702, char_id_b: CHARACTER_A, co_clear_count: 5 },
            ],
        )
        assert.equal(prepareCalls, 1)
    } finally {
        db.prepare = originalPrepare
    }
})

test("candidate context bounds database facts to candidates plus existing unlock characters", () => {
    const candidateCharacterId = 211001
    const playerId = createPlayer("bounded-candidate-rows", [CHARACTER_A, candidateCharacterId])
    makeBaseReady(playerId, CHARACTER_A)
    makeBaseReady(playerId, candidateCharacterId)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_A, 1, 1), true)

    const insertCharacter = db.prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id
        ) VALUES (?, 1, 0, 0, 0, ?, ?, 0, 0, 1, ?)
    `)
    const insertClear = db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 99, 98, 97, 96, 95)
    `)
    const insertCoClear = db.prepare(`
        INSERT INTO players_party_member_co_clears (
            player_id, char_id_a, char_id_b, co_clear_count
        ) VALUES (?, ?, ?, 99)
    `)
    for (let index = 0; index < 24; index++) {
        const unrelatedId = 900000 + index
        insertCharacter.run(
            unrelatedId,
            "2025-01-01T00:00:00.000Z",
            "2025-01-01T00:00:00.000Z",
            playerId,
        )
        insertClear.run(playerId, unrelatedId)
        insertCoClear.run(playerId, unrelatedId, 910000 + index)
    }
    insertCoClear.run(playerId, candidateCharacterId, 220001)

    const observed = []
    const originalPrepare = db.prepare.bind(db)
    db.prepare = sql => {
        const statement = originalPrepare(sql)
        const normalized = String(sql).replace(/\s+/g, " ").trim()
        if (!/^SELECT /i.test(normalized)
            || !/players_characters|players_character_quest_clears|players_party_member_co_clears/.test(
                normalized,
            )) return statement
        return new Proxy(statement, {
            get(target, property) {
                const value = Reflect.get(target, property, target)
                if (typeof value !== "function") return value
                return (...args) => {
                    if (property === "all") observed.push({ sql: normalized, args })
                    return value.apply(target, args)
                }
            },
        })
    }
    let context
    try {
        context = requestContextModule().createAwakeRequestContext({
            playerId,
            evaluationTime,
            candidateCharacterIds: [candidateCharacterId],
        })
    } finally {
        db.prepare = originalPrepare
    }

    assert.deepEqual(
        Object.keys(context.resolver.characters).map(Number).sort((left, right) => left - right),
        [candidateCharacterId, CHARACTER_A].sort((left, right) => left - right),
    )
    const boundedIds = new Set([candidateCharacterId, CHARACTER_A])
    const scopedQueries = observed.filter(entry => (
        entry.sql.includes("players_character_quest_clears")
        || entry.sql.includes("players_party_member_co_clears")
        || (entry.sql.includes("FROM players_characters ")
            && !entry.sql.includes("players_characters_mana_nodes"))
    ))
    assert.equal(scopedQueries.length >= 2, true)
    assert.equal(scopedQueries.every(entry => entry.sql.includes(" IN (")), true)
    assert.equal(scopedQueries.every(entry => (
        entry.args.slice(1).every(value => boundedIds.has(value))
    )), true)
    assert.equal(
        scopedQueries.some(entry => entry.sql.includes("players_character_quest_clears")),
        false,
    )
    assert.equal(
        scopedQueries.some(entry => entry.sql.includes("players_party_member_co_clears")),
        true,
    )

    const reconciled = missionApi().reconcileAwakeUnlocks(
        playerId,
        [candidateCharacterId],
        context,
    )
    assert.deepEqual(reconciled.all.get(String(CHARACTER_A)), { 1: 1 })
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
