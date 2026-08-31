"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-bond-command-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    insertPlayerCharacterBondTokenSync,
    updatePlayerCharacterBondTokenSync,
} = require("../src/data/domains/character")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { receiveBondToken } = require("../src/lib/character-growth/commands/receive-bond-token")
const { updateBondTokenForCompletedBoard } = require("../src/lib/character-helpers")
const { createCharacterGrowthRequestContext } = require("../src/lib/character-growth/request-context")

initializeDatabase()
const db = getDb()

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bond-command-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function state(playerId) {
    return {
        player: getPlayerSync(playerId).bondToken,
        character: getPlayerCharacterSync(playerId, 1).bondTokenList,
    }
}

test("receiveBondToken atomically claims the keyed token and increments bond currency", () => {
    const playerId = createPlayer()
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 1 })
    const before = state(playerId)

    const result = receiveBondToken({
        playerId,
        characterId: 1,
        manaBoardIndex: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.replayed, false)
    assert.equal(result.playerBondTokenBefore, before.player)
    assert.equal(result.playerBondTokenAfter, before.player + 1)
    assert.deepEqual([...result.after.bondTokens], [[1, 2], [2, 0]])
    assert.deepEqual(state(playerId), {
        player: before.player + 1,
        character: [
            { manaBoardIndex: 1, status: 2 },
            { manaBoardIndex: 2, status: 0 },
        ],
    })
})

test("receiveBondToken replay is idempotent and status zero is rejected without writes", () => {
    const playerId = createPlayer()
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 1 })
    const first = receiveBondToken({
        playerId,
        characterId: 1,
        manaBoardIndex: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    const beforeReplay = state(playerId)

    const replay = receiveBondToken({
        playerId,
        characterId: 1,
        manaBoardIndex: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.playerBondTokenBefore, beforeReplay.player)
    assert.equal(replay.playerBondTokenAfter, beforeReplay.player)
    assert.deepEqual(state(playerId), beforeReplay)

    const statusZero = state(playerId)
    assert.throws(
        () => receiveBondToken({
            playerId,
            characterId: 1,
            manaBoardIndex: 2,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "BOND_TOKEN_NOT_EARNED",
    )
    assert.deepEqual(state(playerId), statusZero)
})

test("receiveBondToken persists a reversed-row fixture and still claims by board identity", () => {
    const playerId = createPlayer()
    db.prepare("DELETE FROM players_characters_bond_tokens WHERE player_id = ? AND character_id = 1")
        .run(playerId)
    insertPlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 2, status: 0 })
    insertPlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 1 })

    const result = receiveBondToken({
        playerId,
        characterId: 1,
        manaBoardIndex: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.replayed, false)
    assert.deepEqual([...result.after.bondTokens], [[1, 2], [2, 0]])
    assert.deepEqual(
        db.prepare(`
            SELECT mana_board_index, status
            FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id = 1
            ORDER BY mana_board_index
        `).all(playerId),
        [
            { mana_board_index: 1, status: 2 },
            { mana_board_index: 2, status: 0 },
        ],
    )
})

test("Growth context accepts reversed keyed token input without array-order assumptions", () => {
    const context = createCharacterGrowthRequestContext({
        playerId: 1,
        characterId: 1,
        repository: {
            getCharacterSync: () => ({
                characterId: 1,
                exp: 0,
                stack: 0,
                overLimitStep: 0,
                evolutionLevel: 0,
                manaBoardIndex: 1,
            }),
            getBondTokensSync: () => new Map([[2, 0], [1, 1]]),
            getNormalManaNodesSync: () => new Map(),
            getAwakeUnlocksSync: () => new Map(),
            getRequiredItemsSync: () => new Map(),
        },
        contentFactsLoader: () => ({
            boardCount: 2,
            boardNodeIds: new Map(),
            secondBoardAvailable: true,
        }),
        rarityLoader: () => 4,
    })
    assert.equal(context.bondTokens().get(1), 1)
    assert.equal(context.bondTokens().get(2), 0)
})

test("completed-board helper rejects a missing token row instead of manufacturing status zero", () => {
    const playerId = createPlayer()
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 1
    `).run(playerId)
    const character = getPlayerCharacterSync(playerId, 1)
    const beforeBond = getPlayerSync(playerId).bondToken
    assert.throws(
        () => updateBondTokenForCompletedBoard(playerId, 1, character, 1, true),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(getPlayerSync(playerId).bondToken, beforeBond)
    assert.deepEqual(
        getPlayerCharacterSync(playerId, 1).bondTokenList,
        [{ manaBoardIndex: 2, status: 0 }],
    )
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
