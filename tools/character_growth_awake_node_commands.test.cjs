"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-awake-node-command-"))
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
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { getCharacterDataSync, getCharacterManaNodesSync, getManaNodeAwakeCost } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()

function loadAwakeCommand() {
    try {
        return require("../src/lib/character-growth/commands/awake-mana-nodes")
    } catch (error) {
        assert.fail(`awake-mana-nodes command is not available yet: ${error.message}`)
    }
}

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `awake-node-command-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    require("../src/data/domains/character").updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4][0],
        overLimitStep: 4,
    })
    return playerId
}

function seedBoardOne(playerId) {
    const nodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(playerId, 1, nodeIds)
    upsertPlayerCharacterAwakeUnlockSync(playerId, 1, 1, 1)
    return nodeIds
}

function grantAwakeCost(playerId, nodeId, targetAwakeLevel = 1) {
    assert.equal(targetAwakeLevel, 1, "fixture currently covers the first Awake level")
    const rarity = getCharacterDataSync(1).rarity
    const cost = getManaNodeAwakeCost(1, nodeId, rarity)
    assert.ok(cost, `missing awake cost for ${nodeId}`)
    updatePlayerSync({ id: playerId, freeMana: cost.manaAmount, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(cost.items)) givePlayerItemSync(playerId, itemId, amount)
}

test("awakeManaNodes writes Awake levels on fixed board one and keeps normal board ownership", () => {
    const playerId = createPlayer()
    seedBoardOne(playerId)
    grantAwakeCost(playerId, 2219)
    const beforeBoard = getPlayerCharacterSync(playerId, 1).manaBoardIndex

    const result = loadAwakeCommand().executeAwakeManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2219],
        targetAwakeLevel: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.replayed, false)
    assert.deepEqual(result.changedNodeIds, [2219])
    assert.equal(result.after.manaBoardIndex, beforeBoard)
    assert.equal(getPlayerCharacterSync(playerId, 1).manaBoardIndex, beforeBoard)
    assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, 1)[2219], 1)
    assert.equal(result.after.normalManaNodes.get(2219), 1)
    assert.equal(result.manaBoardAwake, undefined)
})

test("awakeManaNodes only moves Awake state forward and does not spend resources on a no-op", () => {
    const playerId = createPlayer()
    seedBoardOne(playerId)
    db.prepare(`
        UPDATE players_characters_mana_nodes
        SET awake_level = 1
        WHERE player_id = ? AND character_id = 1 AND value = 2219
    `).run(playerId)
    const playerBefore = getPlayerSync(playerId)

    const result = loadAwakeCommand().executeAwakeManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2219],
        targetAwakeLevel: 1,
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.deepEqual(result.changedNodeIds, [])
    assert.equal(result.resourceState, undefined)
    assert.deepEqual(getPlayerSync(playerId), playerBefore)
    assert.equal(result.manaBoardAwake, undefined)
})

test("awakeManaNodes rejects an invalid level, incomplete board, unlearned node, and non-owned board", () => {
    const invalidLevel = createPlayer()
    seedBoardOne(invalidLevel)
    assert.throws(
        () => loadAwakeCommand().executeAwakeManaNodes({
            playerId: invalidLevel,
            characterId: 1,
            requestedNodeIds: [2219],
            targetAwakeLevel: 2,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "INVALID_AWAKE_TARGET",
    )

    const incomplete = createPlayer()
    insertPlayerCharacterManaNodesSync(incomplete, 1, [2201])
    upsertPlayerCharacterAwakeUnlockSync(incomplete, 1, 1, 1)
    assert.throws(
        () => loadAwakeCommand().executeAwakeManaNodes({
            playerId: incomplete,
            characterId: 1,
            requestedNodeIds: [2201],
            targetAwakeLevel: 1,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "PREVIOUS_BOARD_INCOMPLETE",
    )

    const unlearned = createPlayer()
    const allNodes = seedBoardOne(unlearned)
    db.prepare(`
        DELETE FROM players_characters_mana_nodes
        WHERE player_id = ? AND character_id = 1 AND value = 2219
    `).run(unlearned)
    assert.equal(allNodes.includes(2219), true)
    assert.throws(
        () => loadAwakeCommand().executeAwakeManaNodes({
            playerId: unlearned,
            characterId: 1,
            requestedNodeIds: [2219],
            targetAwakeLevel: 1,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "PREVIOUS_BOARD_INCOMPLETE",
    )

    const noUnlock = createPlayer()
    seedBoardOne(noUnlock)
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 1 AND board_index = 1
    `).run(noUnlock)
    assert.throws(
        () => loadAwakeCommand().executeAwakeManaNodes({
            playerId: noUnlock,
            characterId: 1,
            requestedNodeIds: [2219],
            targetAwakeLevel: 1,
            evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
        }),
        error => error.code === "INVALID_AWAKE_TARGET",
    )
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
