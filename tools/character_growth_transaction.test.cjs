"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

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
const { getCharacterManaNodesSync } = require("../src/lib/assets")
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
            SELECT free_mana, paid_mana, bond_token, free_vmoney, exp_pool, total_mana_obtained
            FROM players WHERE id = ?
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
        missionProgress: db.prepare(`
            SELECT category, id, progress
            FROM players_category_missions
            WHERE player_id = ? AND category = 1 ORDER BY id
        `).all(playerId),
        missionStages: db.prepare(`
            SELECT category, id, status, mission_id
            FROM players_category_mission_stages
            WHERE player_id = ? AND category = 1 ORDER BY mission_id, id
        `).all(playerId),
        rewardBalances: db.prepare(`
            SELECT id, amount FROM players_items
            WHERE player_id = ? ORDER BY id
        `).all(playerId),
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

    const parentGuard = await createPlayer(9)
    updatePlayerSync({ id: parentGuard.playerId, freeMana: 1000, paidMana: 0 })
    givePlayerItemSync(parentGuard.playerId, 1, 10)
    const parentGuardResponse = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: parentGuard.viewerId,
            character_id: 1,
            mana_node_multiplied_id_list: [2202],
            api_count: 1,
        },
    })
    assert.equal(parentGuardResponse.statusCode, 400)
    assert.match(parentGuardResponse.body, /PARENT_NOT_LEARNED/)
    assert.deepEqual(characterState(parentGuard.playerId).nodes, [])

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

    const reversedBond = await createPlayer(10)
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1
    `).run(reversedBond.playerId)
    db.prepare(`
        INSERT INTO players_characters_bond_tokens
            (mana_board_index, status, player_id, character_id)
        VALUES (2, 0, ?, 1), (1, 1, ?, 1)
    `).run(reversedBond.playerId, reversedBond.playerId)
    const reversedBondResponse = await app.inject({
        method: "POST",
        url: "/bond/receive_bond_token",
        payload: {
            viewer_id: reversedBond.viewerId,
            character_id: 1,
            mana_board_index: 1,
            api_count: 1,
        },
    })
    assert.equal(reversedBondResponse.statusCode, 200)
    assert.deepEqual(characterState(reversedBond.playerId).bonds, [
        { mana_board_index: 1, status: 2 },
        { mana_board_index: 2, status: 0 },
    ])

    const open = await createPlayer(3)
    updatePlayerCharacterSync(open.playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    const firstBoardNodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    const insertOpenNode = db.prepare(`
        INSERT INTO players_characters_mana_nodes (value, awake_level, player_id, character_id)
        VALUES (?, 0, ?, 1)
    `)
    for (const nodeId of firstBoardNodeIds) insertOpenNode.run(nodeId, open.playerId)
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

    db.exec(`DROP TRIGGER reject_board_open`)
    const openSuccess = await createPlayer(8)
    updatePlayerCharacterSync(openSuccess.playerId, 1, {
        exp: characterExpCaps[4][0],
        evolutionLevel: 3,
        overLimitStep: 4,
    })
    for (const nodeId of firstBoardNodeIds) insertOpenNode.run(nodeId, openSuccess.playerId)
    updatePlayerCharacterBondTokenSync(openSuccess.playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(openSuccess.playerId)
    const openSuccessResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: openSuccess.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(openSuccessResponse.statusCode, 200)
    const openSuccessPayload = unpack(Buffer.from(openSuccessResponse.body, "base64"))
    assert.ok(
        openSuccessPayload.data.mission_info.some(entry => entry.mission_category_id === 1 && entry.mission_id === 95),
        "opening the second mana board should settle regular mission 95 in the same response",
    )
    const openCharacter = openSuccessPayload.data.character_list.find(entry => entry.character_id === 1)
    assert.equal(openCharacter.evolution_level, 3)
    assert.equal(openCharacter.evolution_img_level, 3)
    assert.equal(openCharacter.mana_board_index, 2)
    assert.deepEqual(openCharacter.bond_token_list, [
        { mana_board_index: 1, status: 2 },
        { mana_board_index: 2, status: 0 },
    ])

    const missingHistory = await createPlayer(11)
    updatePlayerCharacterSync(missingHistory.playerId, 1, {
        manaBoardIndex: 2,
    })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 1
    `).run(missingHistory.playerId)
    const beforeMissingHistory = characterState(missingHistory.playerId)
    const missingHistoryResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: missingHistory.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(missingHistoryResponse.statusCode, 400)
    assert.deepEqual(characterState(missingHistory.playerId), beforeMissingHistory)

    const missionFailure = await createPlayer(12)
    updatePlayerCharacterSync(missionFailure.playerId, 1, {
        exp: characterExpCaps[4][0],
        evolutionLevel: 3,
        overLimitStep: 4,
    })
    for (const nodeId of firstBoardNodeIds) insertOpenNode.run(nodeId, missionFailure.playerId)
    updatePlayerCharacterBondTokenSync(missionFailure.playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(missionFailure.playerId)
    const beforeMissionFailure = characterState(missionFailure.playerId)
    db.exec(`
        CREATE TRIGGER reject_open_mission_progress
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${missionFailure.playerId} AND NEW.category = 1
        BEGIN SELECT RAISE(ABORT, 'forced open mission failure'); END;
    `)
    const missionFailureResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: missionFailure.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(missionFailureResponse.statusCode, 500)
    assert.deepEqual(characterState(missionFailure.playerId), beforeMissionFailure)
    db.exec("DROP TRIGGER reject_open_mission_progress")

    const stageFailure = await createPlayer(13)
    updatePlayerCharacterSync(stageFailure.playerId, 1, {
        exp: characterExpCaps[4][0],
        evolutionLevel: 3,
        overLimitStep: 4,
    })
    for (const nodeId of firstBoardNodeIds) insertOpenNode.run(nodeId, stageFailure.playerId)
    updatePlayerCharacterBondTokenSync(stageFailure.playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(stageFailure.playerId)
    const beforeStageFailure = characterState(stageFailure.playerId)
    db.exec(`
        CREATE TRIGGER reject_open_stage_failure
        BEFORE INSERT ON players_category_mission_stages
        WHEN NEW.player_id = ${stageFailure.playerId} AND NEW.category = 1
        BEGIN SELECT RAISE(ABORT, 'forced stage failure'); END;
    `)
    const stageFailureResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: stageFailure.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(stageFailureResponse.statusCode, 500)
    assert.deepEqual(characterState(stageFailure.playerId), beforeStageFailure)
    db.exec("DROP TRIGGER reject_open_stage_failure")

    const rewardFailure = await createPlayer(14)
    updatePlayerCharacterSync(rewardFailure.playerId, 1, {
        exp: characterExpCaps[4][0],
        evolutionLevel: 3,
        overLimitStep: 4,
    })
    for (const nodeId of firstBoardNodeIds) insertOpenNode.run(nodeId, rewardFailure.playerId)
    updatePlayerCharacterBondTokenSync(rewardFailure.playerId, 1, { manaBoardIndex: 1, status: 2 })
    db.prepare(`
        DELETE FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 1 AND mana_board_index = 2
    `).run(rewardFailure.playerId)
    const beforeRewardFailure = characterState(rewardFailure.playerId)
    db.exec(`
        CREATE TRIGGER reject_open_reward_failure
        BEFORE UPDATE OF free_vmoney ON players
        WHEN NEW.id = ${rewardFailure.playerId} AND NEW.free_vmoney > OLD.free_vmoney
        BEGIN SELECT RAISE(ABORT, 'forced reward failure'); END;
    `)
    const rewardFailureResponse = await app.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: rewardFailure.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(rewardFailureResponse.statusCode, 500)
    assert.deepEqual(characterState(rewardFailure.playerId), beforeRewardFailure)
    db.exec("DROP TRIGGER reject_open_reward_failure")

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
