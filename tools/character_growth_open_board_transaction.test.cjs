"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-open-tx-"))
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
const { insertDefaultPlayerSync, getPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getDb } = require("../src/data/db")
const { characterExpCaps } = require("../src/lib/character")
const { getCharacterManaNodesSync } = require("../src/lib/assets")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const bondRoutes = require("../src/routes/api/character/bond").default

initializeDatabase()
const db = getDb()

function createReadyPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `open-tx-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 830000000 + sequence
    updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    db.prepare(`
        UPDATE players_characters_mana_nodes SET awake_level = 0
        WHERE player_id = ? AND character_id = 1
    `).run(playerId)
    for (const nodeId of Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)) {
        db.prepare(`
            INSERT INTO players_characters_mana_nodes (value, awake_level, player_id, character_id)
            VALUES (?, 0, ?, 1)
        `).run(nodeId, playerId)
    }
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(playerId)
    return insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    }).then(() => ({ playerId, viewerId }))
}

function createBondReadyPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bond-tx-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 840000000 + sequence
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 1 })
    return insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    }).then(() => ({ playerId, viewerId }))
}

function requestBody(value) {
    return pack(value).toString("base64")
}

function growthState(playerId) {
    return {
        player: db.prepare(`
            SELECT free_vmoney, free_mana, paid_mana, exp_pool, total_mana_obtained, bond_token
            FROM players WHERE id = ?
        `).get(playerId),
        character: db.prepare(`
            SELECT mana_board_index, update_time
            FROM players_characters WHERE player_id = ? AND id = 1
        `).get(playerId),
        bonds: db.prepare(`
            SELECT mana_board_index, status
            FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id = 1
            ORDER BY mana_board_index
        `).all(playerId),
        progress: db.prepare(`
            SELECT category, id, progress
            FROM players_category_missions
            WHERE player_id = ? AND category = 1
            ORDER BY id
        `).all(playerId),
        stages: db.prepare(`
            SELECT category, id, status, mission_id
            FROM players_category_mission_stages
            WHERE player_id = ? AND category = 1
            ORDER BY mission_id, id
        `).all(playerId),
        items: db.prepare(`
            SELECT id, amount
            FROM players_items WHERE player_id = ? ORDER BY id
        `).all(playerId),
    }
}

async function createApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, unpack(Buffer.from(body, "base64")))
    })
    registerCnMsgpackOnSend(app)
    await app.register(bondRoutes, { prefix: "/bond" })
    await app.ready()
    return app
}

test("receive token transport replay returns the same protocol state without a second grant", async () => {
    const app = await createApp()
    const player = await createBondReadyPlayer(1)
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1
    `).run(player.playerId)
    db.prepare(`
        INSERT INTO players_characters_bond_tokens
            (mana_board_index, status, player_id, character_id)
        VALUES (2, 0, ?, 1), (1, 1, ?, 1)
    `).run(player.playerId, player.playerId)
    const payload = {
        viewer_id: player.viewerId,
        character_id: 1,
        mana_board_index: 1,
        api_count: 1,
    }
    const first = await app.inject({
        method: "POST",
        url: "/bond/receive_bond_token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody(payload),
    })
    const replay = await app.inject({
        method: "POST",
        url: "/bond/receive_bond_token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody(payload),
    })
    assert.equal(first.statusCode, 200)
    assert.equal(replay.statusCode, 200)
    const firstPayload = unpack(Buffer.from(first.body, "base64"))
    const replayPayload = unpack(Buffer.from(replay.body, "base64"))
    assert.deepEqual(replayPayload.data, firstPayload.data)
    assert.deepEqual(firstPayload.data.character_list[0].bond_token_list, [
        { mana_board_index: 1, status: 2 },
        { mana_board_index: 2, status: 0 },
    ])
    assert.equal(getPlayerSync(player.playerId).bondToken, 11)
    await app.close()
})

test("transport replay returns the same protocol shape without a second open", async () => {
    const app = await createApp()
    const player = await createReadyPlayer(1)
    const payload = {
        viewer_id: player.viewerId,
        character_id: 1,
        mana_board_index: 2,
        api_count: 1,
    }
    const first = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody(payload),
    })
    const replay = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody(payload),
    })
    assert.equal(first.statusCode, 200)
    assert.equal(replay.statusCode, 200)
    const firstPayload = unpack(Buffer.from(first.body, "base64"))
    const replayPayload = unpack(Buffer.from(replay.body, "base64"))
    assert.deepEqual(replayPayload.data.character_list, firstPayload.data.character_list)
    assert.deepEqual(replayPayload.data.mission_info, [])
    assert.equal(getPlayerCharacterSync(player.playerId, 1).manaBoardIndex, 2)
    await app.close()
})

test("mission reward failure rolls back token creation and board index", async () => {
    const app = await createApp()
    const player = await createReadyPlayer(2)
    const before = {
        player: getPlayerSync(player.playerId).bondToken,
        character: getPlayerCharacterSync(player.playerId, 1),
    }
    db.exec(`
        CREATE TRIGGER reject_open_mission_progress
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${player.playerId} AND NEW.category = 1
        BEGIN SELECT RAISE(ABORT, 'forced mission settlement failure'); END;
    `)
    const response = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody({
            viewer_id: player.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        }),
    })
    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(player.playerId).bondToken, before.player)
    assert.deepEqual(getPlayerCharacterSync(player.playerId, 1), before.character)
    assert.deepEqual(db.prepare(`
        SELECT mana_board_index, status
        FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1
        ORDER BY mana_board_index
    `).all(player.playerId), [{ mana_board_index: 1, status: 2 }])
    db.exec("DROP TRIGGER reject_open_mission_progress")
    await app.close()
})

test("mission stage failure rolls back progress, stage, token creation, and board index", async () => {
    const app = await createApp()
    const player = await createReadyPlayer(3)
    const before = growthState(player.playerId)
    db.exec(`
        CREATE TRIGGER reject_open_mission_stage
        BEFORE INSERT ON players_category_mission_stages
        WHEN NEW.player_id = ${player.playerId} AND NEW.category = 1
        BEGIN SELECT RAISE(ABORT, 'forced mission stage failure'); END;
    `)
    const response = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody({
            viewer_id: player.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        }),
    })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(growthState(player.playerId), before)
    db.exec("DROP TRIGGER reject_open_mission_stage")
    await app.close()
})

test("mission reward failure rolls back progress, stage, reward balances, token creation, and board index", async () => {
    const app = await createApp()
    const player = await createReadyPlayer(4)
    const before = growthState(player.playerId)
    db.exec(`
        CREATE TRIGGER reject_open_mission_reward
        BEFORE UPDATE OF free_vmoney ON players
        WHEN NEW.id = ${player.playerId} AND NEW.free_vmoney > OLD.free_vmoney
        BEGIN SELECT RAISE(ABORT, 'forced mission reward failure'); END;
    `)
    const response = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: requestBody({
            viewer_id: player.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        }),
    })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(growthState(player.playerId), before)
    db.exec("DROP TRIGGER reject_open_mission_reward")
    await app.close()
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
