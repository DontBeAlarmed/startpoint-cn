"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

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
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { characterExpCaps } = require("../src/lib/character")
const { givePlayerItemSync, getPlayerItemsSync } = require("../src/data/domains/item")
const { getDb } = require("../src/data/db")
const { getCharacterManaNodesSync } = require("../src/lib/assets")
const { getManaNodeAwakeCost } = require("../src/lib/assets")
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const manaRoutes = require("../src/routes/api/character/mana").default
const bondRoutes = require("../src/routes/api/character/bond").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { getTimeOffset, setServerTime, setServerTimeOffset } = require("../src/utils")

initializeDatabase()
const db = getDb()
let routeApp

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
        exp: characterExpCaps[4].at(-1),
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

function grantBoardNodeCosts(playerId, boardId, nodeIds) {
    const nodes = getCharacterManaNodesSync(1, boardId)
    let mana = 0
    const items = new Map()
    for (const nodeId of nodeIds) {
        const node = nodes[String(nodeId)]
        assert.ok(node, `missing board ${boardId} node ${nodeId}`)
        mana += node.manaCost
        for (const [itemId, amount] of Object.entries(node.items)) {
            items.set(itemId, (items.get(itemId) ?? 0) + amount)
        }
    }
    updatePlayerSync({ id: playerId, freeMana: mana, paidMana: 0 })
    for (const [itemId, amount] of items) givePlayerItemSync(playerId, itemId, amount)
}

function grantAwakeNodeCost(playerId, nodeId) {
    const cost = getManaNodeAwakeCost(1, nodeId, 4)
    assert.ok(cost, `missing Awake cost for ${nodeId}`)
    updatePlayerSync({ id: playerId, freeMana: cost.manaAmount, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(cost.items)) givePlayerItemSync(playerId, itemId, amount)
}

function seedBoardOne(playerId) {
    const nodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(playerId, 1, nodeIds)
    return nodeIds
}

async function createReachablePlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `node-route-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 920000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    require("../src/data/domains/character").updatePlayerCharacterSync(playerId, 1, {
        exp: characterExpCaps[4].at(-1),
        overLimitStep: 4,
    })
    return { playerId, viewerId }
}

async function openBoardTwo(player) {
    const response = await routeApp.inject({
        method: "POST",
        url: "/bond/open_mana_board",
        payload: {
            viewer_id: player.viewerId,
            character_id: 1,
            mana_board_index: 2,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
}

async function withBoardTwoAvailable(callback) {
    const previousTimeOffset = getTimeOffset()
    setServerTime(new Date("2024-08-14T12:00:00.000Z"))
    try {
        return await callback()
    } finally {
        setServerTimeOffset(previousTimeOffset)
    }
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

test("learnManaNodes never lowers a historical evolution level", () => {
    const playerId = createPlayer()
    updatePlayerCharacterSync(playerId, 1, { evolutionLevel: 99 })
    grantNodeCost(playerId, [2201])

    const result = loadLearnCommand().executeLearnManaNodes({
        playerId,
        characterId: 1,
        requestedNodeIds: [2201],
        evaluationTime: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.equal(result.after.evolutionLevel, 99)
    assert.equal(getPlayerCharacterSync(playerId, 1).evolutionLevel, 99)
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

test("reachable learn route opens board two and learns its real root node", async () => {
    await withBoardTwoAvailable(async () => {
        const player = await createReachablePlayer()
        seedBoardOne(player.playerId)
        upsertPlayerCharacterAwakeUnlockSync(player.playerId, 1, 1, 1)
        await openBoardTwo(player)
        grantBoardNodeCosts(player.playerId, 2, [2401])

        const response = await routeApp.inject({
            method: "POST",
            url: "/mana/learn_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: [2401],
                api_count: 1,
            },
        })
        assert.equal(response.statusCode, 200, response.body)
        assert.equal(getPlayerCharacterSync(player.playerId, 1).manaBoardIndex, 2)
        assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(player.playerId, 1)[2401], 0)
    })
})

test("reachable order Awake then board two keeps both states authoritative", async () => {
    await withBoardTwoAvailable(async () => {
        const player = await createReachablePlayer()
        seedBoardOne(player.playerId)
        upsertPlayerCharacterAwakeUnlockSync(player.playerId, 1, 1, 1)
        grantAwakeNodeCost(player.playerId, 2219)
        const awakeResponse = await routeApp.inject({
            method: "POST",
            url: "/mana/awake_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: [2219],
                awake_level: 1,
                api_count: 1,
            },
        })
        assert.equal(awakeResponse.statusCode, 200, awakeResponse.body)
        await openBoardTwo(player)
        grantBoardNodeCosts(player.playerId, 2, [2401])
        const learnResponse = await routeApp.inject({
            method: "POST",
            url: "/mana/learn_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: [2401],
                api_count: 1,
            },
        })
        assert.equal(learnResponse.statusCode, 200, learnResponse.body)
        assert.equal(getPlayerCharacterSync(player.playerId, 1).manaBoardIndex, 2)
        assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(player.playerId, 1)[2219], 1)
        assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(player.playerId, 1)[2401], 0)
    })
})

test("reachable order board two then Awake does not change the ordinary board index", async () => {
    await withBoardTwoAvailable(async () => {
        const player = await createReachablePlayer()
        seedBoardOne(player.playerId)
        upsertPlayerCharacterAwakeUnlockSync(player.playerId, 1, 1, 1)
        await openBoardTwo(player)
        grantBoardNodeCosts(player.playerId, 2, [2401])
        const learnResponse = await routeApp.inject({
            method: "POST",
            url: "/mana/learn_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: [2401],
                api_count: 1,
            },
        })
        assert.equal(learnResponse.statusCode, 200, learnResponse.body)
        grantAwakeNodeCost(player.playerId, 2219)
        const awakeResponse = await routeApp.inject({
            method: "POST",
            url: "/mana/awake_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: [2219],
                awake_level: 1,
                api_count: 1,
            },
        })
        assert.equal(awakeResponse.statusCode, 200, awakeResponse.body)
        assert.equal(getPlayerCharacterSync(player.playerId, 1).manaBoardIndex, 2)
        assert.equal(getPlayerCharacterManaNodeAwakeLevelsSync(player.playerId, 1)[2219], 1)
        assert.deepEqual(
            db.prepare(`
                SELECT value, awake_level
                FROM players_characters_mana_nodes
                WHERE player_id = ? AND character_id = 1 AND value = 2401
            `).get(player.playerId),
            { value: 2401, awake_level: 0 },
        )
    })
})

test("reachable board two route completion records the second-board milestone", async () => {
    await withBoardTwoAvailable(async () => {
        const player = await createReachablePlayer()
        seedBoardOne(player.playerId)
        await openBoardTwo(player)
        const boardTwoNodeIds = Object.keys(getCharacterManaNodesSync(1, 2)).map(Number)
        grantBoardNodeCosts(player.playerId, 2, boardTwoNodeIds)
        const response = await routeApp.inject({
            method: "POST",
            url: "/mana/learn_mana_node",
            payload: {
                viewer_id: player.viewerId,
                character_id: 1,
                mana_node_multiplied_id_list: boardTwoNodeIds,
                api_count: 1,
            },
        })
        assert.equal(response.statusCode, 200, response.body)
        assert.deepEqual(
            db.prepare(`
                SELECT aggregation_target, slot, subject_id
                FROM players_player_history_milestones
                WHERE player_id = ?
            `).all(player.playerId),
            [{ aggregation_target: 4, slot: 0, subject_id: 1 }],
        )
    })
})

test.before(async () => {
    routeApp = Fastify({ logger: false })
    registerCnMsgpackOnSend(routeApp)
    await routeApp.register(manaRoutes, { prefix: "/mana" })
    await routeApp.register(bondRoutes, { prefix: "/bond" })
    await routeApp.ready()
})

test.after(async () => {
    if (routeApp) await routeApp.close()
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
