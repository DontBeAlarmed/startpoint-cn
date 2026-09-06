"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-bond-qualification-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterBondTokenSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { getCharacterFacts } = require("../src/lib/character-content")
const getCharacterDataSync = characterId => getCharacterFacts().get(characterId)
const { characterExpCaps } = require("../src/lib/character-growth/exp-caps")
const { mutationContent } = require("../src/lib/character-growth/node-command-support")
const { grantCharacterExp } = require("../src/lib/character-growth/commands/grant-character-exp")
const { executeInjectCharacterExp } = require("../src/lib/character-growth/commands/inject-exp")
const {
    convergeBondTokenForExpWithinTransaction,
    convergeBondTokenForLearnedBoardWithinTransaction,
} = require("../src/lib/character-growth/bond-token-qualification")

initializeDatabase()
const db = getDb()

const PROTAGONIST_ID = 1
const PROTAGONIST_RARITY = getCharacterDataSync(PROTAGONIST_ID).rarity
const BASE_EXP_CAP = characterExpCaps[PROTAGONIST_RARITY][0]

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bond-qualification-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function learnAllBoardOneNodes(playerId) {
    const boardOne = mutationContent(PROTAGONIST_ID, 1)
    const nodeIds = [...Object.keys(boardOne.nodes)].map(Number)
    db.transaction(() => {
        insertPlayerCharacterManaNodesSync(playerId, PROTAGONIST_ID, nodeIds)
    })()
    return nodeIds.length
}

function boardOneStatus(playerId) {
    return getPlayerCharacterSync(playerId, PROTAGONIST_ID).bondTokenList
        .find(token => token.manaBoardIndex === 1).status
}

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("board 1 with every node learned stays status 0 below the base level cap", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP - 1 })

    const nodeReads = []
    const originalProfile = db.profile
    db.profile = statement => {
        if (/players_characters_mana_nodes/.test(statement)) nodeReads.push(statement)
    }
    try {
        const result = grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 0 })
        assert.deepEqual(
            result.bond_token_status_list[String(PROTAGONIST_ID)].after,
            [{ mana_board_index: 1, status: 0 }, { mana_board_index: 2, status: 0 }],
        )
    } finally {
        db.profile = originalProfile
    }

    assert.equal(boardOneStatus(playerId), 0)
    assert.deepEqual(nodeReads, [], "below-cap convergence must not read mana nodes")
})

test("battle EXP crossing the base level cap converges board 1 to status 1", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP - 100 })

    const result = grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 100 })

    assert.equal(boardOneStatus(playerId), 1)
    const after = result.bond_token_status_list[String(PROTAGONIST_ID)].after
    assert.equal(after.find(token => token.mana_board_index === 1).status, 1)
    assert.deepEqual(
        result.bond_token_status_list[String(PROTAGONIST_ID)].before,
        [{ mana_board_index: 1, status: 0 }, { mana_board_index: 2, status: 0 }],
    )
})

test("level reached before nodes: board 1 converges once nodes complete on a later EXP command", () => {
    const playerId = createPlayer()
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP })

    grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 0 })
    assert.equal(boardOneStatus(playerId), 0, "level cap alone must not qualify board 1")

    learnAllBoardOneNodes(playerId)
    grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 0 })
    assert.equal(boardOneStatus(playerId), 1)
})

test("status 1 and status 2 stay sticky across EXP convergence", () => {
    const claimedPlayerId = createPlayer()
    learnAllBoardOneNodes(claimedPlayerId)
    updatePlayerCharacterSync(claimedPlayerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP })
    updatePlayerCharacterBondTokenSync(claimedPlayerId, PROTAGONIST_ID, { manaBoardIndex: 1, status: 1 })
    grantCharacterExp({ playerId: claimedPlayerId, characterIds: [PROTAGONIST_ID], amount: 0 })
    assert.equal(boardOneStatus(claimedPlayerId), 1)

    const receivedPlayerId = createPlayer()
    learnAllBoardOneNodes(receivedPlayerId)
    updatePlayerCharacterSync(receivedPlayerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP })
    updatePlayerCharacterBondTokenSync(receivedPlayerId, PROTAGONIST_ID, { manaBoardIndex: 1, status: 2 })
    const beforeCurrency = getPlayerSync(receivedPlayerId).bondToken
    grantCharacterExp({ playerId: receivedPlayerId, characterIds: [PROTAGONIST_ID], amount: 0 })
    assert.equal(boardOneStatus(receivedPlayerId), 2)
    assert.equal(getPlayerSync(receivedPlayerId).bondToken, beforeCurrency)
})

test("expod inject_exp converges board 1 and reports the after bond tokens", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP - 50 })
    updatePlayerSync({ id: playerId, expPool: 500 })

    const result = executeInjectCharacterExp({
        playerId,
        characterId: PROTAGONIST_ID,
        addExp: 50,
        evaluationTime: new Date(),
    })

    assert.equal(result.addExpList[0].after_exp, BASE_EXP_CAP)
    assert.equal(boardOneStatus(playerId), 1)
    assert.equal(result.bondTokens.get(1), 1)
    assert.equal(result.bondTokens.get(2), 0)
})

test("expod inject_exp below the base cap leaves bond tokens untouched", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerSync({ id: playerId, expPool: 500 })

    executeInjectCharacterExp({
        playerId,
        characterId: PROTAGONIST_ID,
        addExp: 10,
        evaluationTime: new Date(),
    })

    assert.equal(boardOneStatus(playerId), 0)
    assert.equal(
        db.prepare(`
            SELECT COUNT(*) AS writes FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id = ? AND status != 0
        `).get(playerId, PROTAGONIST_ID).writes,
        0,
        "no qualification writes below the base cap",
    )
})

test("EXP convergence below the base cap does not load board Content or nodes", () => {
    const playerId = createPlayer()
    let loads = 0
    const result = db.transaction(() => convergeBondTokenForExpWithinTransaction(
        playerId,
        PROTAGONIST_ID,
        new Map([[1, 0], [2, 0]]),
        {
            rarity: PROTAGONIST_RARITY,
            beforeExp: 0,
            exp: BASE_EXP_CAP - 1,
            loadBoardFacts: () => {
                loads += 1
                throw new Error("below-cap convergence loaded board facts")
            },
        },
    ))()
    assert.equal(result.granted, false)
    assert.equal(loads, 0)
})

test("learn-path derivation grants board 1 only when the base cap is also reached", () => {
    const playerId = createPlayer()
    const nodeIds = [...Object.keys(mutationContent(PROTAGONIST_ID, 1).nodes)].map(Number)
    const learned = new Set(nodeIds)
    const tokens = new Map([[1, 0], [2, 0]])

    assert.throws(
        () => convergeBondTokenForLearnedBoardWithinTransaction(
            playerId,
            PROTAGONIST_ID,
            tokens,
            {
                boardIndex: 1,
                rarity: PROTAGONIST_RARITY,
                exp: BASE_EXP_CAP,
                requiredNodeIds: nodeIds,
                learnedNodeIds: learned,
            },
        ),
        /transaction/i,
    )

    const belowCap = db.transaction(() => convergeBondTokenForLearnedBoardWithinTransaction(
        playerId, PROTAGONIST_ID, tokens,
        {
            boardIndex: 1,
            rarity: PROTAGONIST_RARITY,
            exp: BASE_EXP_CAP - 1,
            requiredNodeIds: nodeIds,
            learnedNodeIds: learned,
        },
    ))()
    assert.equal(belowCap.bondTokenGranted, false)
    assert.equal(boardOneStatus(playerId), 0)

    const atCap = db.transaction(() => convergeBondTokenForLearnedBoardWithinTransaction(
        playerId, PROTAGONIST_ID, tokens,
        {
            boardIndex: 1,
            rarity: PROTAGONIST_RARITY,
            exp: BASE_EXP_CAP,
            requiredNodeIds: nodeIds,
            learnedNodeIds: learned,
        },
    ))()
    assert.equal(atCap.bondTokenGranted, true)
    assert.equal(boardOneStatus(playerId), 1)
})

test("board 2 completion grants its token without any level condition", () => {
    const playerId = createPlayer()
    const boardTwoNodeIds = [...Object.keys(mutationContent(PROTAGONIST_ID, 2).nodes)].map(Number)
    assert.ok(boardTwoNodeIds.length > 0, "board 2 content must exist for the protagonist")

    // Every board-2 node learned while the character is far below the base
    // cap — board 2 must still qualify (client rule: nodes only).
    const granted = db.transaction(() => convergeBondTokenForLearnedBoardWithinTransaction(
        playerId, PROTAGONIST_ID, new Map([[1, 1], [2, 0]]),
        {
            boardIndex: 2,
            rarity: PROTAGONIST_RARITY,
            exp: 10,
            requiredNodeIds: boardTwoNodeIds,
            learnedNodeIds: new Set(boardTwoNodeIds),
        },
    ))()
    assert.equal(granted.bondTokenGranted, true)
    assert.equal(
        getPlayerCharacterSync(playerId, PROTAGONIST_ID).bondTokenList
            .find(token => token.manaBoardIndex === 2).status,
        1,
    )

    // An incomplete board 2 below any level must not grant, and must not
    // roll back the persisted grant from the call above.
    const incomplete = db.transaction(() => convergeBondTokenForLearnedBoardWithinTransaction(
        playerId, PROTAGONIST_ID, new Map([[1, 1], [2, 0]]),
        {
            boardIndex: 2,
            rarity: PROTAGONIST_RARITY,
            exp: 10,
            requiredNodeIds: boardTwoNodeIds,
            learnedNodeIds: new Set(boardTwoNodeIds.slice(1)),
        },
    ))()
    assert.equal(incomplete.bondTokenGranted, false)
    assert.equal(
        getPlayerCharacterSync(playerId, PROTAGONIST_ID).bondTokenList
            .find(token => token.manaBoardIndex === 2).status,
        1,
    )
})

test("missing board-1 row above the base cap fails closed instead of re-granting", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = ? AND mana_board_index = 1
    `).run(playerId, PROTAGONIST_ID)

    assert.throws(
        () => grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 0 }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
})

test("missing board-1 row granted only on a fresh cap crossing", () => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: BASE_EXP_CAP - 100 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = ? AND mana_board_index = 1
    `).run(playerId, PROTAGONIST_ID)

    grantCharacterExp({ playerId, characterIds: [PROTAGONIST_ID], amount: 100 })

    assert.equal(boardOneStatus(playerId), 1)
})

test("bond token write failure rolls the EXP crossing back atomically", t => {
    const playerId = createPlayer()
    learnAllBoardOneNodes(playerId)
    const beforeExp = BASE_EXP_CAP - 100
    updatePlayerCharacterSync(playerId, PROTAGONIST_ID, { exp: beforeExp })
    db.exec(`
        CREATE TRIGGER reject_bond_qualification_update
        BEFORE UPDATE OF status ON players_characters_bond_tokens
        WHEN OLD.player_id = ${playerId}
          AND OLD.character_id = ${PROTAGONIST_ID}
          AND OLD.mana_board_index = 1
        BEGIN SELECT RAISE(ABORT, 'forced bond qualification failure'); END;
    `)
    t.after(() => db.exec("DROP TRIGGER IF EXISTS reject_bond_qualification_update"))

    assert.throws(
        () => grantCharacterExp({
            playerId,
            characterIds: [PROTAGONIST_ID],
            amount: 100,
        }),
        /forced bond qualification failure/,
    )
    assert.equal(getPlayerCharacterSync(playerId, PROTAGONIST_ID).exp, beforeExp)
    assert.equal(boardOneStatus(playerId), 0)
})
