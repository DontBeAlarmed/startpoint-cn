"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-open-command-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    updatePlayerCharacterBondTokenSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { characterExpCaps } = require("../src/lib/character")
const { getCharacterManaNodesSync } = require("../src/lib/assets")
const { openManaBoard } = require("../src/lib/character-growth/commands/open-mana-board")

initializeDatabase()
const db = getDb()

function createReadyPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `open-command-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    const insertNode = db.prepare(`
        INSERT INTO players_characters_mana_nodes (value, awake_level, player_id, character_id)
        VALUES (?, 0, ?, 1)
    `)
    for (const nodeId of Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)) {
        insertNode.run(nodeId, playerId)
    }
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(playerId)
    return playerId
}

test("openManaBoard opens board two, builds missing token rows, and settles category one", () => {
    const playerId = createReadyPlayer()
    const result = openManaBoard({
        playerId,
        characterId: 1,
        targetBoardIndex: 2,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.replayed, false)
    assert.equal(result.after.manaBoardIndex, 2)
    assert.deepEqual([...result.after.bondTokens], [[1, 2], [2, 0]])
    assert.ok(result.missionSettlement)
    assert.equal(
        result.missionSettlement.missionInfo.some(entry =>
            entry.mission_category_id === 1 && entry.mission_id === 95),
        true,
    )
    assert.deepEqual(
        getPlayerCharacterSync(playerId, 1).bondTokenList,
        [
            { manaBoardIndex: 1, status: 2 },
            { manaBoardIndex: 2, status: 0 },
        ],
    )
})

test("openManaBoard exact replay has no writes and invalid board three fails closed", () => {
    const playerId = createReadyPlayer()
    const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
    openManaBoard({ playerId, characterId: 1, targetBoardIndex: 2, evaluationTime })
    const beforeReplay = getPlayerCharacterSync(playerId, 1)
    const replay = openManaBoard({ playerId, characterId: 1, targetBoardIndex: 2, evaluationTime })
    assert.equal(replay.replayed, true)
    assert.equal(replay.missionSettlement, null)
    assert.deepEqual(getPlayerCharacterSync(playerId, 1), beforeReplay)

    const missingHistoryPlayerId = createReadyPlayer()
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 1
    `).run(missingHistoryPlayerId)
    assert.throws(
        () => openManaBoard({
            playerId: missingHistoryPlayerId,
            characterId: 1,
            targetBoardIndex: 2,
            evaluationTime,
        }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.equal(getPlayerCharacterSync(missingHistoryPlayerId, 1).manaBoardIndex, 1)

    assert.throws(
        () => openManaBoard({ playerId, characterId: 1, targetBoardIndex: 3, evaluationTime }),
        error => error.code === "BOARD_NOT_AVAILABLE",
    )
    assert.deepEqual(getPlayerCharacterSync(playerId, 1), beforeReplay)
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
