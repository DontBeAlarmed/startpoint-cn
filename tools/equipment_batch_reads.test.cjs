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
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "equipment-batch-reads-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerEquipmentsByIdsSync,
    getPlayerEquipmentSync,
    insertPlayerEquipmentSync,
    MAX_EQUIPMENT_BATCH_IDS,
    normalizeEquipmentBatchIds,
} = require("../src/data/domains/equipment")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const equipmentRoutes = require("../src/routes/api/equipment").default
const sellRoutes = require("../src/routes/api/sell").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

const CRAFT_POINT_ITEM_ID = 100000
const EQUIPMENT_A = 1111001
const EQUIPMENT_B = 2222001
const UNRELATED_EQUIPMENT = 3333001
const MISSING_EQUIPMENT = 4444001
const EXPECTED_MAX_EQUIPMENT_BATCH_IDS = 32765
const BOUNDARY_EQUIPMENT_IDS = Array.from(
    { length: EXPECTED_MAX_EQUIPMENT_BATCH_IDS },
    (_, index) => index + 1,
)
const OVER_LIMIT_EQUIPMENT_IDS = [...BOUNDARY_EQUIPMENT_IDS, 32766]

let database
let app
let nextViewerId = 890000000
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
    return { playerId, viewerId }
}

function addEquipment(playerId, equipmentId, { level = 1, stack = 1, protection = false } = {}) {
    insertPlayerEquipmentSync(playerId, equipmentId, {
        level,
        enhancementLevel: 0,
        protection,
        stack,
    })
}

function equipmentSelects(statements) {
    return statements.filter(statement => (
        /SELECT\s+id,\s*level,\s*enhancement_level,\s*protection,\s*stack\s+FROM players_equipment/i
            .test(statement)
    ))
}

function assertSingleBatchReadAndFullResponse(statements, uniqueIdCount) {
    const selects = equipmentSelects(statements)
    const batchReads = selects.filter(statement => /\bid\s+IN\s*\(/i.test(statement))
    const singleReads = selects.filter(statement => /\bid\s*=\s*/i.test(statement))
    const fullReads = selects.filter(statement => !/\bAND\s+id\b/i.test(statement))

    assert.equal(batchReads.length, 1, selects.join("\n---\n"))
    assert.equal(singleReads.length, 0, selects.join("\n---\n"))
    assert.equal(fullReads.length, 1, selects.join("\n---\n"))

    const inValues = batchReads[0].match(/\bid\s+IN\s*\(([^)]*)\)/i)?.[1]
    assert.ok(inValues, batchReads[0])
    assert.equal(inValues.split(",").length, uniqueIdCount, batchReads[0])
}

function assertSingleRejectedBatchRead(statements, uniqueIdCount) {
    const selects = equipmentSelects(statements)
    assert.equal(selects.length, 1, selects.join("\n---\n"))
    assert.match(selects[0], /\bid\s+IN\s*\(/i)
    assert.doesNotMatch(selects[0], /\bid\s*=\s*/i)
    const inValues = selects[0].match(/\bid\s+IN\s*\(([^)]*)\)/i)?.[1]
    assert.equal(inValues.split(",").length, uniqueIdCount, selects[0])
}

function decodeSuccess(response) {
    assert.equal(response.statusCode, 200, response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

function equipmentById(responseData, equipmentId) {
    return responseData.data.equipment_list.find(entry => entry.equipment_id === equipmentId)
}

test("equipment batch normalization admits the SQLite-safe unique-ID boundary", () => {
    assert.equal(MAX_EQUIPMENT_BATCH_IDS, EXPECTED_MAX_EQUIPMENT_BATCH_IDS)
    assert.equal(typeof normalizeEquipmentBatchIds, "function")
    assert.deepEqual(normalizeEquipmentBatchIds(BOUNDARY_EQUIPMENT_IDS), BOUNDARY_EQUIPMENT_IDS)
})

test("equipment batch normalization counts unique IDs instead of raw duplicates", () => {
    assert.equal(typeof normalizeEquipmentBatchIds, "function")
    assert.deepEqual(
        normalizeEquipmentBatchIds([...BOUNDARY_EQUIPMENT_IDS, BOUNDARY_EQUIPMENT_IDS[0]]),
        BOUNDARY_EQUIPMENT_IDS,
    )
})

test("equipment batch normalization rejects one unique ID above the SQLite-safe boundary", () => {
    assert.equal(typeof normalizeEquipmentBatchIds, "function")
    assert.equal(normalizeEquipmentBatchIds(OVER_LIMIT_EQUIPMENT_IDS), null)
})

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlTrace.active) sqlTrace.statements.push(statement)
            },
        }),
    })
    app = Fastify({ logger: false, bodyLimit: 262144 })
    registerCnMsgpackOnSend(app)
    await app.register(equipmentRoutes, { prefix: "/equipment" })
    await app.register(sellRoutes, { prefix: "/equipment" })
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

test("equipment batch reader executes the exact 32765-ID SQLite boundary", async () => {
    const { playerId } = await createPlayer("batch-read-exact-boundary")
    addEquipment(playerId, EXPECTED_MAX_EQUIPMENT_BATCH_IDS, {
        level: 7,
        stack: 2,
        protection: true,
    })

    const { result, statements } = await captureSql(() => (
        getPlayerEquipmentsByIdsSync(playerId, BOUNDARY_EQUIPMENT_IDS)
    ))

    const selects = equipmentSelects(statements)
    assert.equal(selects.length, 1, selects.join("\n---\n"))
    const inValues = selects[0].match(/\bid\s+IN\s*\(([^)]*)\)/i)?.[1]
    assert.ok(inValues, selects[0])
    assert.equal(inValues.split(",").length, EXPECTED_MAX_EQUIPMENT_BATCH_IDS)
    assert.deepEqual(result, {
        [EXPECTED_MAX_EQUIPMENT_BATCH_IDS]: {
            level: 7,
            enhancementLevel: 0,
            protection: true,
            stack: 2,
        },
    })
})

test("bulk_upgrade reads unique requested equipment once and returns the full inventory", async () => {
    const { playerId, viewerId } = await createPlayer("bulk-upgrade")
    addEquipment(playerId, EQUIPMENT_A, { stack: 2 })
    addEquipment(playerId, EQUIPMENT_B, { stack: 1 })
    addEquipment(playerId, UNRELATED_EQUIPMENT, { stack: 0 })
    givePlayerItemSync(playerId, CRAFT_POINT_ITEM_ID, 1000)

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/bulk_upgrade",
        payload: {
            viewer_id: viewerId,
            equipment_ids: [EQUIPMENT_B, EQUIPMENT_A, EQUIPMENT_A, MISSING_EQUIPMENT],
        },
    }))

    const responseData = decodeSuccess(response)
    assertSingleBatchReadAndFullResponse(statements, 3)
    assert.deepEqual(equipmentById(responseData, EQUIPMENT_A), {
        equipment_id: EQUIPMENT_A,
        protection: false,
        level: 3,
        enhancement_level: 0,
        stack: 0,
    })
    assert.equal(equipmentById(responseData, EQUIPMENT_B).level, 2)
    assert.ok(equipmentById(responseData, UNRELATED_EQUIPMENT))
    assert.equal(equipmentById(responseData, MISSING_EQUIPMENT), undefined)
})

test("sell_stack aggregates duplicate entries from one requested-equipment snapshot", async () => {
    const { playerId, viewerId } = await createPlayer("sell-stack")
    addEquipment(playerId, EQUIPMENT_A, { stack: 3 })
    addEquipment(playerId, EQUIPMENT_B, { stack: 2 })
    addEquipment(playerId, UNRELATED_EQUIPMENT, { stack: 0 })

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/sell_stack",
        payload: {
            viewer_id: viewerId,
            equipment_list: [
                { equipment_id: EQUIPMENT_A, number: 1 },
                { equipment_id: EQUIPMENT_A, number: 1 },
                { equipment_id: EQUIPMENT_B, number: 1 },
            ],
        },
    }))

    const responseData = decodeSuccess(response)
    assertSingleBatchReadAndFullResponse(statements, 2)
    assert.equal(equipmentById(responseData, EQUIPMENT_A).stack, 1)
    assert.equal(equipmentById(responseData, EQUIPMENT_B).stack, 1)
    assert.ok(equipmentById(responseData, UNRELATED_EQUIPMENT))
})

test("bulk_sell_stack deduplicates IDs, skips missing equipment, and returns the full inventory", async () => {
    const { playerId, viewerId } = await createPlayer("bulk-sell-stack")
    addEquipment(playerId, EQUIPMENT_A, { stack: 2 })
    addEquipment(playerId, EQUIPMENT_B, { stack: 1 })
    addEquipment(playerId, UNRELATED_EQUIPMENT, { stack: 0 })

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/bulk_sell_stack",
        payload: {
            viewer_id: viewerId,
            equipment_ids: [EQUIPMENT_A, EQUIPMENT_A, MISSING_EQUIPMENT, EQUIPMENT_B],
        },
    }))

    const responseData = decodeSuccess(response)
    assertSingleBatchReadAndFullResponse(statements, 3)
    assert.equal(equipmentById(responseData, EQUIPMENT_A).stack, 0)
    assert.equal(equipmentById(responseData, EQUIPMENT_B).stack, 0)
    assert.ok(equipmentById(responseData, UNRELATED_EQUIPMENT))
    assert.equal(equipmentById(responseData, MISSING_EQUIPMENT), undefined)
})

test("bulk_sell_stack does not count duplicate raw IDs toward the batch limit", async () => {
    const { viewerId } = await createPlayer("bulk-sell-stack-limit-duplicates")
    const duplicateIds = Array.from(
        { length: EXPECTED_MAX_EQUIPMENT_BATCH_IDS + 1 },
        () => 1,
    )

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/bulk_sell_stack",
        payload: { viewer_id: viewerId, equipment_ids: duplicateIds },
    }))

    decodeSuccess(response)
    assertSingleRejectedBatchRead(statements, 1)
})

test("sell_stack rejects a missing requested equipment without applying earlier plans", async () => {
    const { playerId, viewerId } = await createPlayer("sell-stack-missing")
    addEquipment(playerId, EQUIPMENT_A, { stack: 2 })

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/sell_stack",
        payload: {
            viewer_id: viewerId,
            equipment_list: [
                { equipment_id: EQUIPMENT_A, number: 1 },
                { equipment_id: MISSING_EQUIPMENT, number: 1 },
            ],
        },
    }))

    assert.equal(response.statusCode, 400, response.body)
    assertSingleRejectedBatchRead(statements, 2)
    assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_A).stack, 2)
    assert.equal(getPlayerItemSync(playerId, CRAFT_POINT_ITEM_ID), null)
})

for (const scenario of [
    {
        name: "sell_stack",
        payload: {
            equipment_list: [
                { equipment_id: EQUIPMENT_A, number: 1 },
                { equipment_id: EQUIPMENT_B, number: 1 },
            ],
        },
    },
    {
        name: "bulk_sell_stack",
        payload: { equipment_ids: [EQUIPMENT_A, EQUIPMENT_B] },
    },
]) {
    test(`${scenario.name} rejects the whole request when any snapshot entry is protected`, async () => {
        const { playerId, viewerId } = await createPlayer(`${scenario.name}-protected-batch`)
        addEquipment(playerId, EQUIPMENT_A, { stack: 2 })
        addEquipment(playerId, EQUIPMENT_B, { stack: 2, protection: true })

        const { result: response, statements } = await captureSql(() => app.inject({
            method: "POST",
            url: `/equipment/${scenario.name}`,
            payload: { viewer_id: viewerId, ...scenario.payload },
        }))

        assert.equal(response.statusCode, 400, response.body)
        assertSingleRejectedBatchRead(statements, 2)
        assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_A).stack, 2)
        assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_B).stack, 2)
    })
}

for (const invalidNumber of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`sell_stack rejects number=${invalidNumber} before reading inventory`, async () => {
        const { viewerId } = await createPlayer(`sell-stack-invalid-number-${invalidNumber}`)

        const { result: response, statements } = await captureSql(() => app.inject({
            method: "POST",
            url: "/equipment/sell_stack",
            payload: {
                viewer_id: viewerId,
                equipment_list: [{ equipment_id: EQUIPMENT_A, number: invalidNumber }],
            },
        }))

        assert.equal(response.statusCode, 400, response.body)
        assert.deepEqual(equipmentSelects(statements), [])
    })
}

test("sell_stack rejects duplicate-count overflow before reading inventory", async () => {
    const { viewerId } = await createPlayer("sell-stack-duplicate-overflow")

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/sell_stack",
        payload: {
            viewer_id: viewerId,
            equipment_list: [
                { equipment_id: EQUIPMENT_A, number: Number.MAX_SAFE_INTEGER },
                { equipment_id: EQUIPMENT_A, number: 1 },
            ],
        },
    }))

    assert.equal(response.statusCode, 400, response.body)
    assert.deepEqual(equipmentSelects(statements), [])
})

for (const invalidEquipmentId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const scenario of [
        { name: "bulk_upgrade", payload: { equipment_ids: [invalidEquipmentId] } },
        {
            name: "sell_stack",
            payload: { equipment_list: [{ equipment_id: invalidEquipmentId, number: 1 }] },
        },
        { name: "bulk_sell_stack", payload: { equipment_ids: [invalidEquipmentId] } },
    ]) {
        test(`${scenario.name} rejects equipment ID ${invalidEquipmentId} before reading inventory`, async () => {
            const { viewerId } = await createPlayer(`${scenario.name}-invalid-id-${invalidEquipmentId}`)

            const { result: response, statements } = await captureSql(() => app.inject({
                method: "POST",
                url: `/equipment/${scenario.name}`,
                payload: { viewer_id: viewerId, ...scenario.payload },
            }))

            assert.equal(response.statusCode, 400, response.body)
            assert.deepEqual(equipmentSelects(statements), [])
        })
    }
}

for (const scenario of [
    { name: "bulk_upgrade", payload: { equipment_ids: OVER_LIMIT_EQUIPMENT_IDS } },
    { name: "bulk_sell_stack", payload: { equipment_ids: OVER_LIMIT_EQUIPMENT_IDS } },
]) {
    test(`${scenario.name} rejects 32766 unique equipment IDs before any database query`, async () => {
        const payload = { viewer_id: nextViewerId++, ...scenario.payload }
        assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 262144)
        const { result: response, statements } = await captureSql(() => app.inject({
            method: "POST",
            url: `/equipment/${scenario.name}`,
            payload,
        }))

        assert.equal(response.statusCode, 400, response.body)
        assert.deepEqual(statements, [])
    })
}

test("sell_stack rejects 32766 equipment objects at the production body limit without SQL", async () => {
    const payload = {
        viewer_id: nextViewerId++,
        equipment_list: OVER_LIMIT_EQUIPMENT_IDS.map(equipmentId => ({
            equipment_id: equipmentId,
            number: 1,
        })),
    }
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 262144)

    const { result: response, statements } = await captureSql(() => app.inject({
        method: "POST",
        url: "/equipment/sell_stack",
        payload,
    }))

    assert.equal(response.statusCode, 413, response.body)
    assert.equal(response.json().code, "FST_ERR_CTP_BODY_TOO_LARGE")
    assert.deepEqual(statements, [])
})
