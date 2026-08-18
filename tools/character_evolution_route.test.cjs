"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-evolution-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db
let app
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
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const { getPlayerItemsSync, givePlayerItemSync } = require("../src/data/domains/item")
const { updatePlayerCategoryMissionSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    getCharacterDataSync,
    getCharacterManaNodesSync,
    getManaNodeAwakeCost,
} = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const manaRoutes = require("../src/routes/api/character/mana").default
const { getTimeOffset, setServerTime, setServerTimeOffset } = require("../src/utils")

const CHARACTER_ID = 1
const AWAKE_CHARACTER_ID = 341005
const AWAKE_MISSION_ID = 3410054
const SLOT_NODE_IDS = [2201, 2207, 2213]
const SKILL_EVOLUTION_NODE_ID = 2219

async function createPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `evolution-route-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 850000000 + sequence
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64")).data
}

function bondTokenList(playerId, characterId = CHARACTER_ID) {
    return db.prepare(`
        SELECT mana_board_index, status
        FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = ?
        ORDER BY mana_board_index
    `).all(playerId, characterId)
}

function routeState(playerId, characterId = CHARACTER_ID) {
    return {
        player: getPlayerSync(playerId),
        character: getPlayerCharacterSync(playerId, characterId),
        items: getPlayerItemsSync(playerId),
        bonds: bondTokenList(playerId, characterId),
        nodes: db.prepare(`
            SELECT value, awake_level
            FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = ?
            ORDER BY value
        `).all(playerId, characterId),
        awakeUnlocks: db.prepare(`
            SELECT character_id, board_index, awake_level
            FROM players_character_awake_unlocks
            WHERE player_id = ? AND character_id = ?
            ORDER BY board_index
        `).all(playerId, characterId),
        usedMana: db.prepare(`
            SELECT total_used_mana_count AS value
            FROM players_active_mission_counters
            WHERE player_id = ?
        `).get(playerId)?.value ?? 0,
    }
}

function seedBoardNodes(playerId, awakeLevels = {}) {
    const boardNodeIds = Object.keys(getCharacterManaNodesSync(CHARACTER_ID, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(playerId, CHARACTER_ID, boardNodeIds)
    const updateAwake = db.prepare(`
        UPDATE players_characters_mana_nodes
        SET awake_level = ?
        WHERE player_id = ? AND character_id = ? AND value = ?
    `)
    for (const [nodeId, awakeLevel] of Object.entries(awakeLevels)) {
        updateAwake.run(awakeLevel, playerId, CHARACTER_ID, Number(nodeId))
    }
    return boardNodeIds
}

function grantLearnCost(playerId, nodeId, characterId = CHARACTER_ID) {
    const node = getCharacterManaNodesSync(characterId, 1)[String(nodeId)]
    updatePlayerSync({ id: playerId, freeMana: node.manaCost, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(node.items)) {
        givePlayerItemSync(playerId, itemId, amount)
    }
}

function grantAwakeCost(playerId, nodeId) {
    const rarity = getCharacterDataSync(CHARACTER_ID).rarity
    const cost = getManaNodeAwakeCost(CHARACTER_ID, nodeId, rarity)
    assert.ok(cost)
    updatePlayerSync({ id: playerId, freeMana: cost.manaAmount, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(cost.items)) {
        givePlayerItemSync(playerId, itemId, amount)
    }
}

function characterEntry(data) {
    return data.character_list.find(entry => entry.character_id === CHARACTER_ID)
}

test.before(async () => {
    db = initializeDatabase()
    app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(manaRoutes, { prefix: "/mana" })
    await app.ready()
})

test("learn_mana_node persists and returns CN evolution before board completion", async () => {
    const learned = await createPlayer(1)
    insertPlayerCharacterManaNodesSync(learned.playerId, CHARACTER_ID, SLOT_NODE_IDS)
    grantLearnCost(learned.playerId, SKILL_EVOLUTION_NODE_ID)
    const learnResponse = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: learned.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [SKILL_EVOLUTION_NODE_ID],
            api_count: 1,
        },
    })
    assert.equal(learnResponse.statusCode, 200, learnResponse.body)
    const learnData = decode(learnResponse)
    assert.equal(getPlayerCharacterSync(learned.playerId, CHARACTER_ID).evolutionLevel, 1)
    assert.equal(characterEntry(learnData).evolution_level, 1)
    assert.equal(characterEntry(learnData).evolution_img_level, 1)
    assert.deepEqual(learnData.evolution, { character_id: CHARACTER_ID, level: 1, img_level: 1 })
    assert.deepEqual(characterEntry(learnData).bond_token_list, bondTokenList(learned.playerId))
    assert.ok(routeState(learned.playerId).nodes.length < Object.keys(getCharacterManaNodesSync(CHARACTER_ID, 1)).length)
})

test("learn_mana_node corrects an overstated persisted evolution without a growth response", async () => {
    const corrected = await createPlayer(6)
    updatePlayerCharacterSync(corrected.playerId, CHARACTER_ID, { evolutionLevel: 3 })
    grantLearnCost(corrected.playerId, 2220)
    const response = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: corrected.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [2220],
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    const data = decode(response)
    assert.equal(getPlayerCharacterSync(corrected.playerId, CHARACTER_ID).evolutionLevel, 0)
    assert.equal(characterEntry(data).evolution_level, 0)
    assert.equal(characterEntry(data).evolution_img_level, 0)
    assert.deepEqual(data.evolution, [])
    assert.deepEqual(characterEntry(data).bond_token_list, bondTokenList(corrected.playerId))
})

test("learn_mana_node rolls back node, costs, bond, and evolution on a late failure", async () => {
    const learnRollback = await createPlayer(2)
    const boardNodeIds = Object.keys(getCharacterManaNodesSync(CHARACTER_ID, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(
        learnRollback.playerId,
        CHARACTER_ID,
        boardNodeIds.filter(nodeId => nodeId !== SKILL_EVOLUTION_NODE_ID),
    )
    grantLearnCost(learnRollback.playerId, SKILL_EVOLUTION_NODE_ID)
    const beforeLearnRollback = routeState(learnRollback.playerId)
    db.exec(`
        CREATE TRIGGER reject_learn_evolution
        BEFORE UPDATE OF evolution_level ON players_characters
        WHEN OLD.player_id = ${learnRollback.playerId}
            AND OLD.id = ${CHARACTER_ID}
            AND NEW.evolution_level = 1
        BEGIN SELECT RAISE(ABORT, 'forced learn evolution failure'); END;
    `)
    const failedLearn = await app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: learnRollback.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [SKILL_EVOLUTION_NODE_ID],
            api_count: 1,
        },
    })
    assert.equal(failedLearn.statusCode, 500)
    assert.deepEqual(routeState(learnRollback.playerId), beforeLearnRollback)
})

test("learn_mana_node rolls back all writes when awake unlock reconciliation fails", async () => {
    const rejectedUnlock = await createPlayer(7)
    insertDefaultPlayerCharacterSync(rejectedUnlock.playerId, AWAKE_CHARACTER_ID)
    const boardNodeIds = Object.keys(getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1)).map(Number)
    const finalNodeId = boardNodeIds.at(-1)
    assert.notEqual(finalNodeId, undefined)
    insertPlayerCharacterManaNodesSync(
        rejectedUnlock.playerId,
        AWAKE_CHARACTER_ID,
        boardNodeIds.filter(nodeId => nodeId !== finalNodeId),
    )
    const rarity = getCharacterDataSync(AWAKE_CHARACTER_ID).rarity
    updatePlayerCharacterSync(rejectedUnlock.playerId, AWAKE_CHARACTER_ID, {
        exp: characterExpCaps[rarity][0],
    })
    updatePlayerCategoryMissionSync(
        rejectedUnlock.playerId,
        9,
        AWAKE_MISSION_ID,
        3,
    )
    grantLearnCost(rejectedUnlock.playerId, finalNodeId, AWAKE_CHARACTER_ID)

    const previousTimeOffset = getTimeOffset()
    setServerTime(new Date("2025-01-01T12:00:00.000Z"))
    try {
        const beforeRejectedUnlock = routeState(rejectedUnlock.playerId, AWAKE_CHARACTER_ID)
        assert.deepEqual(beforeRejectedUnlock.awakeUnlocks, [])
        db.exec(`
            CREATE TRIGGER reject_learn_awake_unlock_insert
            BEFORE INSERT ON players_character_awake_unlocks
            WHEN NEW.player_id = ${rejectedUnlock.playerId}
                AND NEW.character_id = ${AWAKE_CHARACTER_ID}
            BEGIN SELECT RAISE(ABORT, 'forced awake unlock insert failure'); END;

            CREATE TRIGGER reject_learn_awake_unlock_update
            BEFORE UPDATE ON players_character_awake_unlocks
            WHEN NEW.player_id = ${rejectedUnlock.playerId}
                AND NEW.character_id = ${AWAKE_CHARACTER_ID}
            BEGIN SELECT RAISE(ABORT, 'forced awake unlock update failure'); END;
        `)
        const failedLearn = await app.inject({
            method: "POST",
            url: "/mana/learn_mana_node",
            payload: {
                viewer_id: rejectedUnlock.viewerId,
                character_id: AWAKE_CHARACTER_ID,
                mana_node_multiplied_id_list: [finalNodeId],
                api_count: 1,
            },
        })

        assert.equal(failedLearn.statusCode, 500, failedLearn.body)
        assert.deepEqual(
            routeState(rejectedUnlock.playerId, AWAKE_CHARACTER_ID),
            beforeRejectedUnlock,
        )
    } finally {
        setServerTimeOffset(previousTimeOffset)
    }
})

test("awake_mana_node persists and returns the skill requisite awake evolution", async () => {
    const awakened = await createPlayer(3)
    seedBoardNodes(awakened.playerId)
    updatePlayerCharacterSync(awakened.playerId, CHARACTER_ID, { evolutionLevel: 1 })
    upsertPlayerCharacterAwakeUnlockSync(awakened.playerId, CHARACTER_ID, 1, 1)
    grantAwakeCost(awakened.playerId, SKILL_EVOLUTION_NODE_ID)
    const awakeResponse = await app.inject({
        method: "POST",
        url: "/mana/awake_mana_node",
        payload: {
            viewer_id: awakened.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [SKILL_EVOLUTION_NODE_ID],
            awake_level: 1,
            api_count: 1,
        },
    })
    assert.equal(awakeResponse.statusCode, 200, awakeResponse.body)
    const awakeData = decode(awakeResponse)
    assert.equal(getPlayerCharacterSync(awakened.playerId, CHARACTER_ID).evolutionLevel, 2)
    assert.equal(characterEntry(awakeData).evolution_level, 2)
    assert.equal(characterEntry(awakeData).evolution_img_level, 2)
    assert.deepEqual(awakeData.evolution, { character_id: CHARACTER_ID, level: 2, img_level: 2 })
    assert.deepEqual(characterEntry(awakeData).bond_token_list, bondTokenList(awakened.playerId))
})

test("awake_mana_node no-op corrects authoritative evolution from current node state", async () => {
    const corrected = await createPlayer(4)
    seedBoardNodes(corrected.playerId, { [SKILL_EVOLUTION_NODE_ID]: 2 })
    upsertPlayerCharacterAwakeUnlockSync(corrected.playerId, CHARACTER_ID, 1, 2)
    const correctionResponse = await app.inject({
        method: "POST",
        url: "/mana/awake_mana_node",
        payload: {
            viewer_id: corrected.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [SKILL_EVOLUTION_NODE_ID],
            awake_level: 2,
            api_count: 1,
        },
    })
    assert.equal(correctionResponse.statusCode, 200, correctionResponse.body)
    const correctionData = decode(correctionResponse)
    assert.equal(getPlayerCharacterSync(corrected.playerId, CHARACTER_ID).evolutionLevel, 3)
    assert.equal(characterEntry(correctionData).evolution_level, 3)
    assert.deepEqual(correctionData.evolution, { character_id: CHARACTER_ID, level: 3, img_level: 3 })
    assert.deepEqual(characterEntry(correctionData).bond_token_list, bondTokenList(corrected.playerId))
})

test("awake_mana_node rolls back node, costs, and evolution on a late failure", async () => {
    const awakeRollback = await createPlayer(5)
    seedBoardNodes(awakeRollback.playerId)
    updatePlayerCharacterSync(awakeRollback.playerId, CHARACTER_ID, { evolutionLevel: 1 })
    upsertPlayerCharacterAwakeUnlockSync(awakeRollback.playerId, CHARACTER_ID, 1, 1)
    grantAwakeCost(awakeRollback.playerId, SKILL_EVOLUTION_NODE_ID)
    const beforeAwakeRollback = routeState(awakeRollback.playerId)
    db.exec(`
        CREATE TRIGGER reject_awake_evolution
        BEFORE UPDATE OF evolution_level ON players_characters
        WHEN OLD.player_id = ${awakeRollback.playerId}
            AND OLD.id = ${CHARACTER_ID}
            AND NEW.evolution_level = 2
        BEGIN SELECT RAISE(ABORT, 'forced awake evolution failure'); END;
    `)
    const failedAwake = await app.inject({
        method: "POST",
        url: "/mana/awake_mana_node",
        payload: {
            viewer_id: awakeRollback.viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: [SKILL_EVOLUTION_NODE_ID],
            awake_level: 1,
            api_count: 1,
        },
    })
    assert.equal(failedAwake.statusCode, 500)
    assert.deepEqual(routeState(awakeRollback.playerId), beforeAwakeRollback)
})

test.after(async () => {
    await app.close()
    cleanup()
    process.removeListener("exit", cleanup)
})
