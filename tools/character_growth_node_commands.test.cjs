"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-node-command-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    getPlayerCharacterManaNodeAwakeLevelsSync,
    insertPlayerCharacterManaNodesSync,
} = require("../src/data/domains/character")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { characterExpCaps } = require("../src/lib/character")
const { givePlayerItemSync, getPlayerItemsSync } = require("../src/data/domains/item")
const { getDb } = require("../src/data/db")
const { getCharacterManaNodesSync } = require("../src/lib/assets")

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
        idpId: `node-command-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({ id: playerId, freeMana: 0, paidMana: 0 })
    require("../src/data/domains/character").updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    return playerId
}

function grantNodeCost(playerId, nodeIds) {
    const nodes = getCharacterManaNodesSync(1, 1)
    let mana = 0
    const items = new Map()
    for (const nodeId of nodeIds) {
        const node = nodes[String(nodeId)]
        assert.ok(node, `missing node ${nodeId}`)
        mana += node.manaCost
        for (const [itemId, amount] of Object.entries(node.items)) {
            items.set(itemId, (items.get(itemId) ?? 0) + amount)
        }
    }
    updatePlayerSync({ id: playerId, freeMana: mana, paidMana: 0 })
    for (const [itemId, amount] of items) givePlayerItemSync(playerId, itemId, amount)
}

test("learnManaNodes uses DB/content costs and persists a normal node", () => {
    const playerId = createPlayer()
    grantNodeCost(playerId, [2201])

    const result = loadLearnCommand().executeLearnManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2201],
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.replayed, false)
    assert.deepEqual(result.changedNodeIds, [2201])
    assert.equal(result.resourceState.mana, 0)
    assert.equal(getPlayerSync(playerId).freeMana + getPlayerSync(playerId).paidMana, 0)
    assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, 1)[2201], 0)
    assert.equal(result.after.normalManaNodes.get(2201), 0)
    assert.ok(result.missionFacts)
})

test("learnManaNodes aggregates shared item costs before producing absolute after-state", () => {
    const playerId = createPlayer()
    grantNodeCost(playerId, [2201, 2202])

    const result = loadLearnCommand().executeLearnManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2201, 2202],
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.deepEqual(result.changedNodeIds, [2201, 2202])
    assert.equal(result.resourceState.mana, 0)
    assert.equal(result.resourceState.items.get(1), 0)
    assert.equal(result.resourceState.items.get(2) ?? 0, 0)
    assert.deepEqual(
        db.prepare(`
            SELECT value, awake_level
            FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = 1
            ORDER BY value
        `).all(playerId),
        [
            { value: 2201, awake_level: 0 },
            { value: 2202, awake_level: 0 },
        ],
    )
})

test("learnManaNodes derives completion from after-state and earns the keyed board token", () => {
    const playerId = createPlayer()
    const allNodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(
        playerId,
        1,
        allNodeIds.filter(nodeId => nodeId !== 2201),
    )
    grantNodeCost(playerId, [2201])

    const result = loadLearnCommand().executeLearnManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2201],
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.bondTokenGranted, true)
    assert.equal(result.after.bondTokens.get(1), 1)
    assert.deepEqual(
        getPlayerCharacterSync(playerId, 1).bondTokenList.find(token => token.manaBoardIndex === 1),
        { manaBoardIndex: 1, status: 1 },
    )
})

test("learnManaNodes rejects duplicate, unknown, already learned, and unparented nodes", () => {
    const duplicate = createPlayer()
    assert.throws(
        () => loadLearnCommand().executeLearnManaNodes({
            playerId: duplicate,
            characterId: 1,
            requestedNodeIds: [2201, 2201],
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "DUPLICATE_NODE",
    )

    const unknown = createPlayer()
    assert.throws(
        () => loadLearnCommand().executeLearnManaNodes({
            playerId: unknown,
            characterId: 1,
            requestedNodeIds: [99999999],
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "UNKNOWN_NODE",
    )

    const parent = createPlayer()
    grantNodeCost(parent, [2207])
    assert.throws(
        () => loadLearnCommand().executeLearnManaNodes({
            playerId: parent,
            characterId: 1,
            requestedNodeIds: [2207],
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "PARENT_NOT_LEARNED",
    )

    const learned = createPlayer()
    insertPlayerCharacterManaNodesSync(learned, 1, [2201])
    assert.throws(
        () => loadLearnCommand().executeLearnManaNodes({
            playerId: learned,
            characterId: 1,
            requestedNodeIds: [2201],
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "ALREADY_LEARNED",
    )
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
