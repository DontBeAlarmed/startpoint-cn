"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-node-tx-"))
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
} = require("../src/data/domains/character")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { givePlayerItemSync, getPlayerItemsSync } = require("../src/data/domains/item")
const { getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()

function loadLearnCommand() {
    try {
        return require("../src/lib/character-growth/commands/learn-mana-nodes")
    } catch (error) {
        assert.fail(`learn-mana-nodes command is not available yet: ${error.message}`)
    }
}

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `node-tx-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    require("../src/data/domains/character").updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    return playerId
}

function grantNodeCost(playerId, nodeId) {
    const node = getCharacterManaNodesSync(1, 1)[String(nodeId)]
    assert.ok(node)
    updatePlayerSync({ id: playerId, freeMana: node.manaCost, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(node.items)) givePlayerItemSync(playerId, itemId, amount)
}

function state(playerId) {
    return {
        player: getPlayerSync(playerId),
        character: getPlayerCharacterSync(playerId, 1),
        items: getPlayerItemsSync(playerId),
        nodes: db.prepare(`
            SELECT value, awake_level
            FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = 1
            ORDER BY value
        `).all(playerId),
        usedMana: db.prepare(`
            SELECT total_used_mana_count AS value
            FROM players_active_mission_counters
            WHERE player_id = ?
        `).get(playerId)?.value ?? 0,
    }
}

test("learnManaNodes rolls back resource, mission fact, node, token, and evolution writes together", () => {
    const playerId = createPlayer()
    const allNodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    const finalNodeId = 2201
    insertPlayerCharacterManaNodesSync(
        playerId,
        1,
        allNodeIds.filter(nodeId => nodeId !== finalNodeId),
    )
    updatePlayerCharacterBondTokenSync(playerId, 1, { manaBoardIndex: 1, status: 0 })
    grantNodeCost(playerId, finalNodeId)
    const before = state(playerId)
    db.exec(`
        CREATE TRIGGER reject_growth_mission_fact
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced growth mission fact failure'); END;
    `)

    assert.throws(
        () => loadLearnCommand().executeLearnManaNodes({
            playerId,
            characterId: 1,
            requestedNodeIds: [finalNodeId],
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        /forced growth mission fact failure/,
    )
    assert.deepEqual(state(playerId), before)
    db.exec("DROP TRIGGER reject_growth_mission_fact")
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
