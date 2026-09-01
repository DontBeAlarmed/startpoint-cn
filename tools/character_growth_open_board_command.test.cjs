"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

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
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { characterExpCaps } = require("../src/lib/character")
const { getCharacterManaNodesSync } = require("../src/lib/assets")
const { openManaBoard } = require("../src/lib/character-growth/commands/open-mana-board")
const { getCharacterGrowthContentFactsSync } = require("../src/lib/character-growth/content-facts")
const manaRoutes = require("../src/routes/api/character/mana").default
const bondRoutes = require("../src/routes/api/character/bond").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { getClientSerializedData } = require("../src/data/utils/player-data")
const {
    MANA_CHARACTER_GROWTH_FIELDS,
    projectCharacterGrowthIncrement,
} = require("../src/lib/character-growth/response-projector")

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

function createEligibleIncompletePlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `open-incomplete-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    return { playerId, accountId: account.id }
}

async function createAdapterApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, require("msgpackr").unpack(Buffer.from(body, "base64")))
    })
    registerCnMsgpackOnSend(app)
    await app.register(manaRoutes, { prefix: "/mana" })
    await app.register(bondRoutes, { prefix: "/bond" })
    await app.ready()
    return app
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
    const persistedCharacter = getPlayerCharacterSync(playerId, 1)
    assert.equal(
        result.character.updateTime.toISOString(),
        persistedCharacter.updateTime.toISOString(),
    )
    assert.equal(result.character.manaBoardIndex, 2)
    assert.deepEqual(result.character.bondTokenList, persistedCharacter.bondTokenList)

    const responseCharacter = projectCharacterGrowthIncrement(result, {
        character: result.character,
        fields: [...MANA_CHARACTER_GROWTH_FIELDS, "mana_board_index"],
    }).character_list[0]
    const mergedClient = {
        mana_board_index: 1,
        bond_token_list: [{ mana_board_index: 1, status: 2 }],
        ...responseCharacter,
    }
    const nextLoad = getClientSerializedData(playerId, { viewerId: 1 })
    const loadedCharacter = nextLoad.user_character_list["1"]
    const expectedGrowth = {
        mana_board_index: 2,
        bond_token_list: [
            { mana_board_index: 1, status: 2 },
            { mana_board_index: 2, status: 0 },
        ],
    }
    assert.deepEqual({
        mana_board_index: result.after.manaBoardIndex,
        bond_token_list: [...result.after.bondTokens]
            .map(([mana_board_index, status]) => ({ mana_board_index, status })),
    }, expectedGrowth)
    assert.deepEqual({
        mana_board_index: mergedClient.mana_board_index,
        bond_token_list: mergedClient.bond_token_list,
    }, expectedGrowth)
    assert.deepEqual({
        mana_board_index: loadedCharacter.mana_board_index,
        bond_token_list: loadedCharacter.bond_token_list,
    }, expectedGrowth)
})

test("openManaBoard rejects an invalid raw protection value before Growth or mission writes", () => {
    const playerId = createReadyPlayer()
    db.prepare(`
        UPDATE players_characters
        SET protection = 2
        WHERE player_id = ? AND id = 1
    `).run(playerId)
    const missionProgressBefore = db.prepare(`
        SELECT category, id, progress
        FROM players_category_missions
        WHERE player_id = ? AND category = 1
        ORDER BY id
    `).all(playerId)
    const missionStagesBefore = db.prepare(`
        SELECT category, id, status, mission_id
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 1
        ORDER BY mission_id, id
    `).all(playerId)
    const itemsBefore = db.prepare(`
        SELECT id, amount
        FROM players_items
        WHERE player_id = ?
        ORDER BY id
    `).all(playerId)

    assert.throws(
        () => openManaBoard({
            playerId,
            characterId: 1,
            targetBoardIndex: 2,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    const persisted = getPlayerCharacterSync(playerId, 1)
    assert.equal(persisted.manaBoardIndex, 1)
    assert.equal(db.prepare(`
        SELECT protection
        FROM players_characters
        WHERE player_id = ? AND id = 1
    `).get(playerId).protection, 2)
    assert.equal(
        persisted.bondTokenList.some(token => token.manaBoardIndex === 2),
        false,
    )
    assert.deepEqual(db.prepare(`
        SELECT category, id, progress
        FROM players_category_missions
        WHERE player_id = ? AND category = 1
        ORDER BY id
    `).all(playerId), missionProgressBefore)
    assert.deepEqual(db.prepare(`
        SELECT category, id, status, mission_id
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 1
        ORDER BY mission_id, id
    `).all(playerId), missionStagesBefore)
    assert.deepEqual(db.prepare(`
        SELECT id, amount
        FROM players_items
        WHERE player_id = ?
        ORDER BY id
    `).all(playerId), itemsBefore)
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

test("openManaBoard rejects incomplete, downgrade, and jump requests at the command boundary", () => {
    const incomplete = createEligibleIncompletePlayer()
    assert.throws(
        () => openManaBoard({
            playerId: incomplete.playerId,
            characterId: 1,
            targetBoardIndex: 2,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "PREVIOUS_BOARD_INCOMPLETE",
    )

    const ready = createReadyPlayer()
    openManaBoard({
        playerId: ready,
        characterId: 1,
        targetBoardIndex: 2,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    assert.throws(
        () => openManaBoard({
            playerId: ready,
            characterId: 1,
            targetBoardIndex: 1,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "INVALID_GROWTH_STATE",
    )
    assert.throws(
        () => openManaBoard({
            playerId: incomplete.playerId,
            characterId: 1,
            targetBoardIndex: 3,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "BOARD_NOT_AVAILABLE",
    )
})

test("content loader rejects a missing board node table instead of exposing an empty board", () => {
    const assets = require("../src/lib/assets")
    const originalGetNodes = assets.getCharacterManaNodesSync
    assets.getCharacterManaNodesSync = (characterId, boardIndex) => (
        boardIndex === 1 ? null : originalGetNodes(characterId, boardIndex)
    )
    try {
        assert.throws(
            () => getCharacterGrowthContentFactsSync(1),
            error => error.code === "CONTENT_INVALID",
        )
        const playerId = createReadyPlayer()
        assert.throws(
            () => openManaBoard({
                playerId,
                characterId: 1,
                targetBoardIndex: 2,
                evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
            }),
            error => error.code === "CONTENT_INVALID",
        )
        assert.equal(getPlayerCharacterSync(playerId, 1).manaBoardIndex, 1)
    } finally {
        assets.getCharacterManaNodesSync = originalGetNodes
    }
})

test("a real mana-node route can complete board one before the Growth command opens board two", async () => {
    const app = await createAdapterApp()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `open-reachable-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 850000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    updatePlayerSync({ id: playerId, freeMana: 1_000_000, paidMana: 0 })
    const boardNodes = getCharacterManaNodesSync(1, 1)
    const itemIds = new Set(Object.values(boardNodes).flatMap(node => Object.keys(node.items).map(Number)))
    for (const itemId of itemIds) givePlayerItemSync(playerId, itemId, 100_000)
    const response = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: viewerId,
            character_id: 1,
            mana_node_multiplied_id_list: Object.keys(boardNodes).map(Number),
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200)
    const completed = getPlayerCharacterSync(playerId, 1)
    assert.equal(completed.bondTokenList.find(token => token.manaBoardIndex === 1).status, 1)
    const claimed = require("../src/lib/character-growth/commands/receive-bond-token").receiveBondToken({
        playerId,
        characterId: 1,
        manaBoardIndex: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    assert.equal(claimed.replayed, false)
    const opened = openManaBoard({
        playerId,
        characterId: 1,
        targetBoardIndex: 2,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    assert.equal(opened.replayed, false)
    assert.equal(opened.after.manaBoardIndex, 2)
    await app.close()
})

test("HTTP adapter maps incomplete, true downgrade, and unsupported board three representatives to 400", async () => {
    const app = await createAdapterApp()
    const incomplete = createEligibleIncompletePlayer()
    const incompleteViewerId = 860000000 + incomplete.playerId
    const incompleteAccount = db.prepare("SELECT account_id FROM players WHERE id = ?").get(incomplete.playerId)
    await insertSessionWithToken({
        token: String(incompleteViewerId),
        accountId: incompleteAccount.account_id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    const request = (viewerId, targetBoardIndex) => app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: { viewer_id: viewerId, character_id: 1, mana_board_index: targetBoardIndex, api_count: 1 },
    })
    const incompleteResponse = await request(incompleteViewerId, 2)
    assert.equal(incompleteResponse.statusCode, 400)
    assert.match(incompleteResponse.body, /PREVIOUS_BOARD_INCOMPLETE/)

    const opened = createReadyPlayer()
    openManaBoard({
        playerId: opened,
        characterId: 1,
        targetBoardIndex: 2,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })
    const openedViewerId = 861000000 + opened
    const openedAccount = db.prepare("SELECT account_id FROM players WHERE id = ?").get(opened)
    await insertSessionWithToken({
        token: String(openedViewerId),
        accountId: openedAccount.account_id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    const downgradeResponse = await request(openedViewerId, 1)
    assert.equal(downgradeResponse.statusCode, 400)
    assert.match(downgradeResponse.body, /INVALID_GROWTH_STATE/)

    const unsupportedBoardResponse = await request(openedViewerId, 3)
    assert.equal(unsupportedBoardResponse.statusCode, 400)
    assert.match(unsupportedBoardResponse.body, /BOARD_NOT_AVAILABLE/)
    await app.close()
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
