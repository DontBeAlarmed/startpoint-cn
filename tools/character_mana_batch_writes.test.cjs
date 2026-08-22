"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { pack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-mana-batch-writes-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterManaNodeAwakeLevelsBatchSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const {
    getPlayerItemsSync,
    givePlayerItemSync,
    setPlayerItemWithinTransactionSync,
} = require("../src/data/domains/item")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    getCharacterDataSync,
    getCharacterManaNodesSync,
    getManaNodeAwakeCost,
} = require("../src/lib/assets")
const manaRoutes = require("../src/routes/api/character/mana").default

const CHARACTER_ID = 1
const LEARN_NODE_IDS = [2201, 2202, 2203, 2204, 2205, 2206, 2207]
const AWAKE_NODE_IDS = [2201, 2202]
const ROLLBACK_AWAKE_NODE_IDS = [2201, 2219]

let database
let app
let nextViewerId = 895000000
const sqlTrace = { active: false, statements: [] }

async function captureSql(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        const result = await operation()
        return { result, statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    updatePlayerCharacterSync(playerId, CHARACTER_ID, { exp: 100000 })
    return { playerId, viewerId }
}

function statementsMatching(statements, pattern) {
    return statements.filter(statement => pattern.test(statement))
}

function itemInventorySelects(statements) {
    return statementsMatching(statements, /SELECT\s+id,\s*amount\s+FROM players_items/i)
}

function manaNodeInserts(statements) {
    return statementsMatching(statements, /INSERT INTO players_characters_mana_nodes/i)
}

function manaNodeAwakeUpdates(statements) {
    return statementsMatching(
        statements,
        /UPDATE players_characters_mana_nodes\s+SET awake_level/i,
    )
}

function grantLearnCosts(playerId, nodeIds) {
    const nodes = getCharacterManaNodesSync(CHARACTER_ID, 1)
    let mana = 0
    const items = {}
    for (const nodeId of nodeIds) {
        const node = nodes[String(nodeId)]
        mana += node.manaCost
        for (const [itemId, amount] of Object.entries(node.items)) {
            items[itemId] = (items[itemId] ?? 0) + amount
        }
    }
    updatePlayerSync({ id: playerId, freeMana: mana, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(items)) {
        givePlayerItemSync(playerId, itemId, amount)
    }
}

function grantAwakeCosts(playerId, nodeIds) {
    const rarity = getCharacterDataSync(CHARACTER_ID).rarity
    let mana = 0
    const items = {}
    for (const nodeId of nodeIds) {
        const cost = getManaNodeAwakeCost(CHARACTER_ID, nodeId, rarity)
        assert.ok(cost, `missing awake cost for ${nodeId}`)
        mana += cost.manaAmount
        for (const [itemId, amount] of Object.entries(cost.items)) {
            items[itemId] = (items[itemId] ?? 0) + amount
        }
    }
    updatePlayerSync({ id: playerId, freeMana: mana, paidMana: 0 })
    for (const [itemId, amount] of Object.entries(items)) {
        givePlayerItemSync(playerId, itemId, amount)
    }
}

function seedCompleteBoard(playerId) {
    const nodeIds = Object.keys(getCharacterManaNodesSync(CHARACTER_ID, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(playerId, CHARACTER_ID, nodeIds)
}

function manaMutationState(playerId) {
    return {
        playerMana: database.prepare(`
            SELECT free_mana, paid_mana FROM players WHERE id = ?
        `).get(playerId),
        items: database.prepare(`
            SELECT id, amount FROM players_items WHERE player_id = ? ORDER BY id
        `).all(playerId),
        nodes: database.prepare(`
            SELECT value, awake_level FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = ? ORDER BY value
        `).all(playerId, CHARACTER_ID),
        evolution: database.prepare(`
            SELECT evolution_level FROM players_characters
            WHERE player_id = ? AND id = ?
        `).get(playerId, CHARACTER_ID),
        taskFacts: database.prepare(`
            SELECT * FROM players_active_mission_counters WHERE player_id = ?
        `).get(playerId) ?? null,
    }
}

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlTrace.active) sqlTrace.statements.push(statement)
            },
        }),
    })
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

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("transaction-owned item setter handles existing and missing zero rows without SELECT", async () => {
    const { playerId } = await createPlayer("item-snapshot")
    givePlayerItemSync(playerId, 99, 5)

    const { statements } = await captureSql(() => database.transaction(() => {
        setPlayerItemWithinTransactionSync(playerId, 99, 0, true)
        setPlayerItemWithinTransactionSync(playerId, 70047, 0, false)
    })())

    assert.equal(itemInventorySelects(statements).length, 0, statements.join("\n---\n"))
    assert.deepEqual(getPlayerItemsSync(playerId), { "99": 0, "70047": 0 })
})

test("mana node insert validates, deduplicates, and emits one multi-value INSERT", async () => {
    const { playerId } = await createPlayer("batch-insert")
    const { statements } = await captureSql(() => {
        insertPlayerCharacterManaNodesSync(playerId, CHARACTER_ID, [2201, 2202, 2201])
    })

    const inserts = manaNodeInserts(statements)
    assert.equal(inserts.length, 1, inserts.join("\n---\n"))
    assert.match(inserts[0], /VALUES\s*\([^)]*\)\s*,\s*\([^)]*\)/i)
    assert.deepEqual(database.prepare(`
        SELECT value FROM players_characters_mana_nodes
        WHERE player_id = ? AND character_id = ? ORDER BY value
    `).all(playerId, CHARACTER_ID), [{ value: 2201 }, { value: 2202 }])

    assert.throws(
        () => insertPlayerCharacterManaNodesSync(0, CHARACTER_ID, [2203]),
        /playerId.*positive safe integer/i,
    )
    assert.throws(
        () => insertPlayerCharacterManaNodesSync(playerId, 0, [2203]),
        /characterId.*positive safe integer/i,
    )
    assert.throws(
        () => insertPlayerCharacterManaNodesSync(playerId, CHARACTER_ID, [0]),
        /nodeId.*positive safe integer/i,
    )
})

test("empty mana node batches perform no INSERT or UPDATE", async () => {
    const { playerId } = await createPlayer("empty-batches")
    const { statements } = await captureSql(() => {
        insertPlayerCharacterManaNodesSync(playerId, CHARACTER_ID, [])
        updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [])
    })

    assert.equal(manaNodeInserts(statements).length, 0)
    assert.equal(manaNodeAwakeUpdates(statements).length, 0)
})

test("awake batch validates, deduplicates, and emits one UPDATE", async () => {
    const { playerId } = await createPlayer("batch-awake")
    database.prepare(`
        INSERT INTO players_characters_mana_nodes (value, character_id, player_id)
        VALUES (2201, ?, ?), (2202, ?, ?)
    `).run(CHARACTER_ID, playerId, CHARACTER_ID, playerId)

    const { statements } = await captureSql(() => {
        updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [
            { nodeId: 2201, awakeLevel: 1 },
            { nodeId: 2201, awakeLevel: 1 },
            { nodeId: 2202, awakeLevel: 2 },
        ])
    })

    const updates = manaNodeAwakeUpdates(statements)
    assert.equal(updates.length, 1, updates.join("\n---\n"))
    assert.match(updates[0], /WITH\s+node_updates/i)
    assert.deepEqual(database.prepare(`
        SELECT value, awake_level FROM players_characters_mana_nodes
        WHERE player_id = ? AND character_id = ? ORDER BY value
    `).all(playerId, CHARACTER_ID), [
        { value: 2201, awake_level: 1 },
        { value: 2202, awake_level: 2 },
    ])

    assert.throws(
        () => updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [
            { nodeId: 2201, awakeLevel: 1 },
            { nodeId: 2201, awakeLevel: 2 },
        ]),
        /conflicting awake levels/i,
    )
    assert.throws(
        () => updatePlayerCharacterManaNodeAwakeLevelsBatchSync(0, CHARACTER_ID, []),
        /playerId.*positive safe integer/i,
    )
    assert.throws(
        () => updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, 0, []),
        /characterId.*positive safe integer/i,
    )
    assert.throws(
        () => updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [
            { nodeId: 0, awakeLevel: 1 },
        ]),
        /nodeId.*positive safe integer/i,
    )
    assert.throws(
        () => updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [
            { nodeId: 2201, awakeLevel: -1 },
        ]),
        /awakeLevel.*non-negative safe integer/i,
    )
})

test("awake batch rejects affected-row mismatches and rolls back its partial UPDATE", async () => {
    const { playerId } = await createPlayer("batch-awake-mismatch")
    database.prepare(`
        INSERT INTO players_characters_mana_nodes (value, character_id, player_id)
        VALUES (2201, ?, ?)
    `).run(CHARACTER_ID, playerId)

    assert.throws(
        () => database.transaction(() => {
            updatePlayerCharacterManaNodeAwakeLevelsBatchSync(playerId, CHARACTER_ID, [
                { nodeId: 2201, awakeLevel: 1 },
                { nodeId: 2202, awakeLevel: 1 },
            ])
        })(),
        /updated 1 of 2/i,
    )
    assert.equal(database.prepare(`
        SELECT awake_level FROM players_characters_mana_nodes
        WHERE player_id = ? AND character_id = ? AND value = 2201
    `).get(playerId, CHARACTER_ID).awake_level, 0)
})

test("learn route reuses one item snapshot and inserts all requested nodes once", async () => {
    const { playerId, viewerId } = await createPlayer("learn-route")
    grantLearnCosts(playerId, LEARN_NODE_IDS)

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/mana/learn_mana_node",
        payload: {
            viewer_id: viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: LEARN_NODE_IDS,
            api_count: 1,
        },
    }))

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(itemInventorySelects(statements).length, 1, statements.join("\n---\n"))
    const inserts = manaNodeInserts(statements)
    assert.equal(inserts.length, 1, inserts.join("\n---\n"))
    assert.equal(
        database.prepare(`
            SELECT COUNT(*) AS count FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = ?
        `).get(playerId, CHARACTER_ID).count,
        LEARN_NODE_IDS.length,
    )
})

test("awake route reuses one item snapshot and updates all requested nodes once", async () => {
    const { playerId, viewerId } = await createPlayer("awake-route")
    seedCompleteBoard(playerId)
    upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_ID, 1, 1)
    grantAwakeCosts(playerId, AWAKE_NODE_IDS)

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/mana/awake_mana_node",
        payload: {
            viewer_id: viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: AWAKE_NODE_IDS,
            awake_level: 1,
            api_count: 1,
        },
    }))

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(itemInventorySelects(statements).length, 1, statements.join("\n---\n"))
    assert.equal(manaNodeAwakeUpdates(statements).length, 1, statements.join("\n---\n"))
})

test("awake affected-row mismatch rolls back mana, items, nodes, evolution, and task facts", async () => {
    const { playerId, viewerId } = await createPlayer("awake-route-rollback")
    seedCompleteBoard(playerId)
    updatePlayerCharacterSync(playerId, CHARACTER_ID, { evolutionLevel: 1 })
    upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_ID, 1, 1)
    grantAwakeCosts(playerId, ROLLBACK_AWAKE_NODE_IDS)
    const before = manaMutationState(playerId)
    database.exec(`
        CREATE TRIGGER ignore_one_awake_update
        BEFORE UPDATE OF awake_level ON players_characters_mana_nodes
        WHEN OLD.player_id = ${playerId}
            AND OLD.character_id = ${CHARACTER_ID}
            AND OLD.value = 2219
        BEGIN SELECT RAISE(IGNORE); END;
    `)

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/mana/awake_mana_node",
        payload: {
            viewer_id: viewerId,
            character_id: CHARACTER_ID,
            mana_node_multiplied_id_list: ROLLBACK_AWAKE_NODE_IDS,
            awake_level: 1,
            api_count: 1,
        },
    }))

    assert.equal(response.statusCode, 500, response.body)
    assert.equal(manaNodeAwakeUpdates(statements).length, 1, statements.join("\n---\n"))
    assert.deepEqual(manaMutationState(playerId), before)
})
