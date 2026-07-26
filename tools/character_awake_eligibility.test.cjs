require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-eligibility-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const {
    installBundledCharacterSnapshot,
} = require("./helpers/install-bundled-character-snapshot.cjs")
restoreContentSnapshot = installBundledCharacterSnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterManaNodeAwakeLevelSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const characterAssets = require("../src/lib/assets")
const { getCharacterDataSync, getCharacterManaNodesSync } = characterAssets
const { characterExpCaps } = require("../src/lib/character")
const {
    createCharacterAwakeEligibilityResolver,
    computeAwakeSummary,
    isCharacterAwakeBaseReady,
    isCharacterAwakeNewUnlockEligible,
    reconcileAwakeUnlockCharacterList,
    reconcileAwakeUnlocks,
    reconcileAwakeUnlocksFromProgress,
} = require("../src/lib/mission")
const characterManaRoutes = require("../src/routes/api/character/mana").default
const { getTimeOffset, setServerTime } = require("../src/utils")

initializeDatabase()
db = getDb()
const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => require("../src/utils").setServerTimeOffset(previousTimeOffset)

const characterId = 341005
const missionProgress = [
    { missionId: 3410051, progress: 1 },
    { missionId: 3410052, progress: 5 },
    { missionId: 3410053, progress: 5 },
    { missionId: 3410054, progress: 3 },
]
const boardOneNodeIds = Object.keys(getCharacterManaNodesSync(characterId, 1)).map(Number)
const boardTwoNodeIds = Object.keys(getCharacterManaNodesSync(characterId, 2)).map(Number)
const rarity = getCharacterDataSync(characterId).rarity
const baseExpCap = characterExpCaps[rarity][0]

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, characterId)
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 5, 0, 0, 0, 0)
    `).run(playerId, characterId)
    return { account, playerId }
}

function setBaseCap(playerId) {
    updatePlayerCharacterSync(playerId, characterId, { exp: baseExpCap })
}

function learnBoardOne(playerId, nodeIds = boardOneNodeIds) {
    insertPlayerCharacterManaNodesSync(playerId, characterId, nodeIds)
}

function summaryForCharacter(playerId) {
    return computeAwakeSummary(playerId).activeMissionList
        .filter(entry => Math.floor(entry.mission_id / 10) === characterId)
}

function reconcileCompletedProgress(playerId) {
    return reconcileAwakeUnlocksFromProgress(playerId, missionProgress)
}

async function testEligibilityAndCleanup() {
    setServerTime(new Date("2025-01-01T12:00:00.000Z"))

    const emptyBoard = createPlayer("awake-empty-board")
    setBaseCap(emptyBoard.playerId)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(emptyBoard.playerId, characterId, 1, 1), true)
    const originalGetCharacterManaNodesSync = characterAssets.getCharacterManaNodesSync
    characterAssets.getCharacterManaNodesSync = (candidateCharacterId, boardIndex) =>
        Number(candidateCharacterId) === characterId && Number(boardIndex) === 1
            ? {}
            : originalGetCharacterManaNodesSync(candidateCharacterId, boardIndex)
    try {
        assert.equal(isCharacterAwakeBaseReady(emptyBoard.playerId, characterId), false)
        assert.equal(
            isCharacterAwakeNewUnlockEligible(
                emptyBoard.playerId,
                characterId,
                missionProgress[0].missionId,
            ),
            false,
        )
        assert.deepEqual(
            reconcileAwakeUnlocksFromProgress(emptyBoard.playerId, []).all.get(String(characterId)),
            { 1: 1 },
            "empty board-one master data must not delete an existing unlock",
        )
    } finally {
        characterAssets.getCharacterManaNodesSync = originalGetCharacterManaNodesSync
    }

    const missingAsset = createPlayer("awake-missing-asset")
    learnBoardOne(missingAsset.playerId)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(missingAsset.playerId, characterId, 1, 1), true)
    const originalGetCharacterDataSync = characterAssets.getCharacterDataSync
    characterAssets.getCharacterDataSync = candidateCharacterId =>
        Number(candidateCharacterId) === characterId
            ? null
            : originalGetCharacterDataSync(candidateCharacterId)
    try {
        assert.equal(
            isCharacterAwakeNewUnlockEligible(
                missingAsset.playerId,
                characterId,
                missionProgress[0].missionId,
            ),
            false,
        )
        assert.deepEqual(
            reconcileAwakeUnlocksFromProgress(missingAsset.playerId, []).all.get(String(characterId)),
            { 1: 1 },
            "missing character master data must not delete an existing unlock",
        )
    } finally {
        characterAssets.getCharacterDataSync = originalGetCharacterDataSync
    }

    const lowLevel = createPlayer("awake-low-level")
    learnBoardOne(lowLevel.playerId)
    assert.deepEqual(summaryForCharacter(lowLevel.playerId), [])
    assert.equal(reconcileCompletedProgress(lowLevel.playerId).all.has(String(characterId)), false)

    const incompleteBoard = createPlayer("awake-incomplete-board")
    setBaseCap(incompleteBoard.playerId)
    learnBoardOne(incompleteBoard.playerId, boardOneNodeIds.slice(0, -1))
    assert.deepEqual(summaryForCharacter(incompleteBoard.playerId), [])
    assert.equal(reconcileCompletedProgress(incompleteBoard.playerId).all.has(String(characterId)), false)

    const closedActivity = createPlayer("awake-closed-activity")
    setBaseCap(closedActivity.playerId)
    learnBoardOne(closedActivity.playerId)
    setServerTime(new Date("2024-08-14T12:00:00.000Z"))
    assert.deepEqual(summaryForCharacter(closedActivity.playerId), [])
    assert.equal(reconcileCompletedProgress(closedActivity.playerId).all.has(String(characterId)), false)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(closedActivity.playerId, characterId, 1, 1), true)
    assert.deepEqual(
        reconcileAwakeUnlocksFromProgress(closedActivity.playerId, []).all.get(String(characterId)),
        { 1: 1 },
    )

    const eligible = createPlayer("awake-eligible")
    setBaseCap(eligible.playerId)
    learnBoardOne(eligible.playerId)
    setServerTime(new Date("2025-01-01T12:00:00.000Z"))
    const eligibleSummary = computeAwakeSummary(eligible.playerId)
    const eligibleMissions = eligibleSummary.activeMissionList
        .filter(entry => Math.floor(entry.mission_id / 10) === characterId)
    assert.equal(eligibleMissions.length, 4)
    assert.equal(eligibleMissions.flatMap(entry => entry.stages).every(stage => stage.received === false), true)
    assert.equal(
        boardTwoNodeIds.some(nodeId =>
            db.prepare(`
                SELECT 1 FROM players_characters_mana_nodes
                WHERE player_id = ? AND character_id = ? AND value = ?
            `).get(eligible.playerId, characterId, nodeId)
        ),
        false,
    )
    const published = reconcileCompletedProgress(eligible.playerId)
    assert.deepEqual(published.changed.get(String(characterId)), { 1: 1 })
    assert.deepEqual(published.all.get(String(characterId)), { 1: 1 })
    assert.deepEqual(published.removed, new Map())

    const invalidPersistedContract = createPlayer("awake-invalid-persisted-contract")
    learnBoardOne(invalidPersistedContract.playerId, boardOneNodeIds.slice(0, 1))
    assert.equal(
        upsertPlayerCharacterAwakeUnlockSync(invalidPersistedContract.playerId, characterId, 1, 1),
        true,
    )
    const removedUnlocks = reconcileAwakeUnlocksFromProgress(
        invalidPersistedContract.playerId,
        [],
    )
    assert.deepEqual(removedUnlocks.all, new Map())
    assert.deepEqual(removedUnlocks.changed, new Map())
    assert.deepEqual(removedUnlocks.removed, new Map([[String(characterId), { 1: 1 }]]))

    const invalidPersisted = createPlayer("awake-invalid-persisted")
    learnBoardOne(invalidPersisted.playerId, boardOneNodeIds.slice(0, 1))
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(invalidPersisted.playerId, characterId, 1, 1), true)
    const existingBondTokenList = [{ mana_board_index: 1, status: 1 }]
    const invalidPersistedResponse = reconcileAwakeUnlockCharacterList(
        invalidPersisted.playerId,
        [{
            character_id: characterId,
            evolution_level: 2,
            bond_token_list: existingBondTokenList,
            mana_board_awake: { 1: 1 },
        }],
    )
    assert.equal(invalidPersistedResponse.length, 1)
    assert.equal(invalidPersistedResponse[0].character_id, characterId)
    assert.equal(invalidPersistedResponse[0].evolution_level, 2)
    assert.strictEqual(invalidPersistedResponse[0].bond_token_list, existingBondTokenList)
    assert.deepEqual(invalidPersistedResponse[0].mana_board_awake, {})
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(invalidPersisted.playerId), new Map())

    setBaseCap(invalidPersisted.playerId)
    learnBoardOne(invalidPersisted.playerId, boardOneNodeIds.slice(1))
    const newlyUnlockedResponse = reconcileAwakeUnlockCharacterList(
        invalidPersisted.playerId,
        [{
            character_id: characterId,
            evolution_level: 2,
            bond_token_list: existingBondTokenList,
            mana_board_awake: { 1: 2, 2: 1 },
        }],
    )
    assert.equal(newlyUnlockedResponse.length, 1)
    assert.equal(newlyUnlockedResponse[0].evolution_level, 2)
    assert.strictEqual(newlyUnlockedResponse[0].bond_token_list, existingBondTokenList)
    assert.deepEqual(newlyUnlockedResponse[0].mana_board_awake, { 1: 2, 2: 1 })

    const invalidPersistedWithoutExisting = createPlayer("awake-invalid-persisted-no-existing")
    learnBoardOne(invalidPersistedWithoutExisting.playerId, boardOneNodeIds.slice(0, 1))
    assert.equal(
        upsertPlayerCharacterAwakeUnlockSync(
            invalidPersistedWithoutExisting.playerId,
            characterId,
            1,
            1,
        ),
        true,
    )
    assert.deepEqual(
        reconcileAwakeUnlockCharacterList(invalidPersistedWithoutExisting.playerId, []),
        [{ character_id: characterId, mana_board_awake: {} }],
    )

    const awakenedPersisted = createPlayer("awake-awakened-persisted")
    learnBoardOne(awakenedPersisted.playerId, boardOneNodeIds.slice(0, 1))
    updatePlayerCharacterManaNodeAwakeLevelSync(
        awakenedPersisted.playerId,
        characterId,
        boardOneNodeIds[0],
        1,
    )
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(awakenedPersisted.playerId, characterId, 1, 1), true)
    assert.deepEqual(
        reconcileAwakeUnlocksFromProgress(awakenedPersisted.playerId, []).all.get(String(characterId)),
        { 1: 1 },
    )
    assert.equal(
        getPlayerCharactersManaNodeAwakeLevelsSync(awakenedPersisted.playerId)[String(characterId)][boardOneNodeIds[0]],
        1,
    )
}

function testEligibilityResolverCachesBatchState() {
    setServerTime(new Date("2025-01-01T12:00:00.000Z"))
    const { playerId } = createPlayer("awake-resolver-cache")
    setBaseCap(playerId)
    learnBoardOne(playerId)

    const originalPrepare = db.prepare.bind(db)
    const originalGetCharacterDataSync = characterAssets.getCharacterDataSync
    const originalGetCharacterManaNodesSync = characterAssets.getCharacterManaNodesSync
    const counts = {
        characterBatch: 0,
        manaNodeBatch: 0,
        characterSingle: 0,
        manaNodeSingle: 0,
        characterAsset: 0,
        boardAsset: 0,
    }
    db.prepare = sql => {
        const normalized = String(sql).replace(/\s+/g, " ").trim()
        if (normalized.includes("FROM players_characters WHERE player_id = ? AND id = ?")) {
            counts.characterSingle++
        } else if (normalized.includes("FROM players_characters WHERE player_id = ?")) {
            counts.characterBatch++
        }
        if (normalized.includes("FROM players_characters_mana_nodes WHERE character_id = ? AND player_id = ?")) {
            counts.manaNodeSingle++
        } else if (normalized.startsWith("SELECT value, character_id FROM players_characters_mana_nodes WHERE player_id = ?")) {
            counts.manaNodeBatch++
        }
        return originalPrepare(sql)
    }
    characterAssets.getCharacterDataSync = candidateCharacterId => {
        if (Number(candidateCharacterId) === characterId) counts.characterAsset++
        return originalGetCharacterDataSync(candidateCharacterId)
    }
    characterAssets.getCharacterManaNodesSync = (candidateCharacterId, boardIndex) => {
        if (Number(candidateCharacterId) === characterId && Number(boardIndex) === 1) counts.boardAsset++
        return originalGetCharacterManaNodesSync(candidateCharacterId, boardIndex)
    }

    try {
        const resolver = createCharacterAwakeEligibilityResolver(playerId, new Date("2025-01-01T12:00:00.000Z"))
        assert.equal(resolver.getBaseReadiness(characterId), "ready")
        assert.equal(resolver.getBaseReadiness(characterId), "ready")
        assert.equal(resolver.isNewUnlockEligible(characterId, missionProgress[0].missionId), true)
        assert.equal(resolver.isNewUnlockEligible(characterId, missionProgress[1].missionId), true)
        assert.deepEqual(counts, {
            characterBatch: 1,
            manaNodeBatch: 1,
            characterSingle: 0,
            manaNodeSingle: 0,
            characterAsset: 1,
            boardAsset: 1,
        })
    } finally {
        db.prepare = originalPrepare
        characterAssets.getCharacterDataSync = originalGetCharacterDataSync
        characterAssets.getCharacterManaNodesSync = originalGetCharacterManaNodesSync
    }
}

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function testLastLearnedNodePublishesUnlock() {
    setServerTime(new Date("2025-01-01T12:00:00.000Z"))
    const { account, playerId } = createPlayer("awake-last-node")
    setBaseCap(playerId)
    const finalNodeId = boardOneNodeIds[0]
    learnBoardOne(playerId, boardOneNodeIds.slice(1))
    updatePlayerSync({ id: playerId, freeMana: 1_000_000, paidMana: 0 })
    givePlayerItemSync(playerId, 13, 1_000)

    const viewerId = 800000242
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

    const fastify = Fastify()
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(characterManaRoutes, { prefix: "/api/index.php/character" })
    await fastify.ready()

    try {
        const response = await fastify.inject({
            method: "POST",
            url: "/api/index.php/character/learn_mana_node",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                character_id: characterId,
                api_count: 1,
                mana_node_multiplied_id_list: [finalNodeId],
            }),
        })
        assert.equal(response.statusCode, 200, response.body)
        const character = decodeResponse(response).data.character_list
            .find(entry => entry.character_id === characterId)
        assert.equal(character.evolution_level, 1)
        assert.ok(Array.isArray(character.bond_token_list))
        assert.deepEqual(character.mana_board_awake, { 1: 1 })
        assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get(String(characterId)), { 1: 1 })
    } finally {
        await fastify.close()
    }
}

async function main() {
    try {
        await testEligibilityAndCleanup()
        testEligibilityResolverCachesBatchState()
        await testLastLearnedNodePublishesUnlock()
        console.log("character awake eligibility tests passed")
    } finally {
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
