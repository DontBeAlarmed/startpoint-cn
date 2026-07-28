"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-tx-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterBondTokenSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { givePlayerItemSync, getPlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, getPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { characterExpCaps } = require("../src/lib/character")
const manaRoutes = require("../src/routes/api/character/mana").default
const bondRoutes = require("../src/routes/api/character/bond").default
const characterRoutes = require("../src/routes/api/character").default
const exBoostRoutes = require("../src/routes/api/exBoost").default

async function createPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `growth-tx-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 820000000 + sequence
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function characterState(playerId) {
    return {
        player: db.prepare(`
            SELECT free_mana, paid_mana, bond_token FROM players WHERE id = ?
        `).get(playerId),
        character: db.prepare(`
            SELECT evolution_level, mana_board_index FROM players_characters
            WHERE player_id = ? AND id = 1
        `).get(playerId),
        bonds: db.prepare(`
            SELECT mana_board_index, status FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id = 1 ORDER BY mana_board_index
        `).all(playerId),
        nodes: db.prepare(`
            SELECT value, awake_level FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = 1 ORDER BY value
        `).all(playerId),
        item: getPlayerItemSync(playerId, 1),
    }
}

async function main() {
    db = initializeDatabase()
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(manaRoutes, { prefix: "/mana" })
    await app.register(bondRoutes, { prefix: "/bond" })
    await app.register(characterRoutes, { prefix: "/character" })
    await app.register(exBoostRoutes, { prefix: "/ex" })
    await app.ready()

    const learn = await createPlayer(1)
    updatePlayerSync({ id: learn.playerId, freeMana: 1000, paidMana: 0 })
    givePlayerItemSync(learn.playerId, 1, 10)
    const beforeLearn = characterState(learn.playerId)
    db.exec(`
        CREATE TRIGGER reject_learn_node
        BEFORE INSERT ON players_characters_mana_nodes
        WHEN NEW.player_id = ${learn.playerId}
        BEGIN SELECT RAISE(ABORT, 'forced learn failure'); END;
    `)
    const learnResponse = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: learn.viewerId,
            character_id: 1,
            mana_node_multiplied_id_list: [2201],
            api_count: 1,
        },
    })
    assert.equal(learnResponse.statusCode, 500)
    assert.deepEqual(characterState(learn.playerId), beforeLearn)

    const bond = await createPlayer(2)
    updatePlayerCharacterBondTokenSync(bond.playerId, 1, { manaBoardIndex: 1, status: 1 })
    const beforeBond = characterState(bond.playerId)
    db.exec(`
        CREATE TRIGGER reject_bond_claim
        BEFORE UPDATE OF status ON players_characters_bond_tokens
        WHEN OLD.player_id = ${bond.playerId} AND NEW.status = 2
        BEGIN SELECT RAISE(ABORT, 'forced bond failure'); END;
    `)
    const bondResponse = await app.inject({
        method: "POST",
        url: "/bond/receive_bond_token",
        payload: {
            viewer_id: bond.viewerId,
            character_id: 1,
            mana_board_index: 1,
            api_count: 1,
        },
    })
    assert.equal(bondResponse.statusCode, 500)
    assert.deepEqual(characterState(bond.playerId), beforeBond)

    const open = await createPlayer(3)
    updatePlayerCharacterSync(open.playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    updatePlayerCharacterBondTokenSync(open.playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(open.playerId)
    const beforeOpen = characterState(open.playerId)
    db.exec(`
        CREATE TRIGGER reject_board_open
        BEFORE UPDATE OF mana_board_index ON players_characters
        WHEN OLD.player_id = ${open.playerId} AND NEW.mana_board_index = 2
        BEGIN SELECT RAISE(ABORT, 'forced open failure'); END;
    `)
    const openResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: open.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(openResponse.statusCode, 500)
    assert.deepEqual(characterState(open.playerId), beforeOpen)

    const overLimit = await createPlayer(4)
    givePlayerItemSync(overLimit.playerId, 10002, 1)
    const beforeOverLimit = getPlayerCharacterSync(overLimit.playerId, 1)
    db.exec(`
        CREATE TRIGGER reject_over_limit
        BEFORE UPDATE OF over_limit_step ON players_characters
        WHEN OLD.player_id = ${overLimit.playerId} AND OLD.id = 1
        BEGIN SELECT RAISE(ABORT, 'forced over limit failure'); END;
    `)
    const overLimitResponse = await app.inject({
        method: "POST",
        url: "/character/over_limit",
        payload: {
            viewer_id: overLimit.viewerId,
            character_id: 1,
            use_stack: false,
            item_id: 10002,
            over_limit_count: 1,
        },
    })
    assert.equal(overLimitResponse.statusCode, 500)
    assert.equal(getPlayerItemSync(overLimit.playerId, 10002), 1)
    assert.deepEqual(getPlayerCharacterSync(overLimit.playerId, 1), beforeOverLimit)

    const bulk = await createPlayer(5)
    insertDefaultPlayerCharacterSync(bulk.playerId, 10)
    updatePlayerCharacterSync(bulk.playerId, 1, { stack: 1 })
    updatePlayerCharacterSync(bulk.playerId, 10, { stack: 1 })
    const beforeBulkFirst = getPlayerCharacterSync(bulk.playerId, 1)
    const beforeBulkSecond = getPlayerCharacterSync(bulk.playerId, 10)
    db.exec(`
        CREATE TRIGGER reject_bulk_over_limit
        BEFORE UPDATE OF over_limit_step ON players_characters
        WHEN OLD.player_id = ${bulk.playerId} AND OLD.id = 10
        BEGIN SELECT RAISE(ABORT, 'forced bulk over limit failure'); END;
    `)
    const bulkResponse = await app.inject({
        method: "POST",
        url: "/character/bulk_over_limit",
        payload: { viewer_id: bulk.viewerId },
    })
    assert.equal(bulkResponse.statusCode, 500)
    assert.deepEqual(getPlayerCharacterSync(bulk.playerId, 1), beforeBulkFirst)
    assert.deepEqual(getPlayerCharacterSync(bulk.playerId, 10), beforeBulkSecond)

    const firstDraw = await createPlayer(6)
    updatePlayerCharacterSync(firstDraw.playerId, 1, { overLimitStep: 6 })
    givePlayerItemSync(firstDraw.playerId, 10002, 1)
    const beforeFirstDraw = getPlayerCharacterSync(firstDraw.playerId, 1)
    db.exec(`
        CREATE TRIGGER reject_first_ex_boost
        BEFORE UPDATE OF ex_boost_status_id ON players_characters
        WHEN OLD.player_id = ${firstDraw.playerId} AND OLD.id = 1
        BEGIN SELECT RAISE(ABORT, 'forced first ex boost failure'); END;
    `)
    const firstDrawResponse = await app.inject({
        method: "POST",
        url: "/ex/first_draw",
        payload: { viewer_id: firstDraw.viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(firstDrawResponse.statusCode, 500)
    assert.equal(getPlayerItemSync(firstDraw.playerId, 10002), 1)
    assert.deepEqual(getPlayerCharacterSync(firstDraw.playerId, 1), beforeFirstDraw)

    const select = await createPlayer(7)
    updatePlayerCharacterSync(select.playerId, 1, { overLimitStep: 6 })
    givePlayerItemSync(select.playerId, 10002, 1)
    const drawResponse = await app.inject({
        method: "POST",
        url: "/ex/draw",
        payload: { viewer_id: select.viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(drawResponse.statusCode, 200)
    db.exec(`
        CREATE TRIGGER reject_selected_ex_boost
        BEFORE UPDATE OF ex_boost_status_id ON players_characters
        WHEN OLD.player_id = ${select.playerId} AND OLD.id = 1
        BEGIN SELECT RAISE(ABORT, 'forced selected ex boost failure'); END;
    `)
    const failedSelectResponse = await app.inject({
        method: "POST",
        url: "/ex/select",
        payload: { viewer_id: select.viewerId, is_confirm: true },
    })
    assert.equal(failedSelectResponse.statusCode, 500)
    db.exec("DROP TRIGGER reject_selected_ex_boost")
    const retrySelectResponse = await app.inject({
        method: "POST",
        url: "/ex/select",
        payload: { viewer_id: select.viewerId, is_confirm: true },
    })
    assert.equal(retrySelectResponse.statusCode, 200)

    await app.close()
    cleanup()
    process.removeListener("exit", cleanup)
}

main().then(
    () => console.log("character growth transaction tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
