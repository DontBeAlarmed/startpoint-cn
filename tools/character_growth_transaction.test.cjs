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
