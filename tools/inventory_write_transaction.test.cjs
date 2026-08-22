"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerEquipmentSync,
    insertPlayerEquipmentSync,
} = require("../src/data/domains/equipment")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const equipmentRoutes = require("../src/routes/api/equipment").default
const itemRoutes = require("../src/routes/api/item").default
const sellRoutes = require("../src/routes/api/sell").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let database
let app
let nextViewerId = 830000000

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

function addEquipment(playerId, equipmentId, stack = 1, protection = false) {
    insertPlayerEquipmentSync(playerId, equipmentId, {
        level: 1,
        enhancementLevel: 0,
        protection,
        stack,
    })
}

function rejectNextRewardInsert(playerId, triggerName) {
    database.prepare("DELETE FROM players_items WHERE player_id = ? AND id IN (100000, 3010006, 3020003)")
        .run(playerId)
    database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced reward failure'); END;
    `)
}

test.before(async () => {
    database = data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(itemRoutes, { prefix: "/item" })
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

test("duplicate stamina item ids are aggregated before deduction", async () => {
    const { playerId, viewerId } = await createPlayer("duplicate-stamina")
    updatePlayerSync({ id: playerId, stamina: 0, staminaHealTime: new Date() })
    givePlayerItemSync(playerId, 100, 2)

    const response = await app.inject({
        method: "POST",
        url: "/item/use_item",
        payload: {
            viewer_id: viewerId,
            items: [
                { id: 100, number: 1, selectIndex: 0 },
                { id: 100, number: 1, selectIndex: 0 },
            ],
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerItemSync(playerId, 100), 0)
})

test("stamina recovery rolls item deduction back when player update fails", async t => {
    const { playerId, viewerId } = await createPlayer("stamina-rollback")
    updatePlayerSync({ id: playerId, stamina: 0, staminaHealTime: new Date() })
    givePlayerItemSync(playerId, 100, 1)
    database.exec(`
        CREATE TRIGGER reject_stamina_update
        BEFORE UPDATE OF stamina ON players
        WHEN OLD.id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced stamina failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_stamina_update"))

    const response = await app.inject({
        method: "POST",
        url: "/item/use_item",
        payload: { viewer_id: viewerId, items: [{ id: 100, number: 1, selectIndex: 0 }] },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, 100), 1)
    assert.equal(getPlayerSync(playerId).stamina, 0)
})

test("item sale rolls item deduction back when mana update fails", async t => {
    const { playerId, viewerId } = await createPlayer("item-sell-rollback")
    givePlayerItemSync(playerId, 30005, 10)
    const beforeMana = getPlayerSync(playerId).freeMana
    database.exec(`
        CREATE TRIGGER reject_item_sale_mana
        BEFORE UPDATE OF free_mana ON players
        WHEN OLD.id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced mana failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_item_sale_mana"))

    const response = await app.inject({
        method: "POST",
        url: "/item/sell",
        payload: { viewer_id: viewerId, item_id: 30005, sell_number: 3 },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, 30005), 10)
    assert.equal(getPlayerSync(playerId).freeMana, beforeMana)
})

test("sell_equipment sells the base equipment when duplicate stack is zero", async () => {
    const { playerId, viewerId } = await createPlayer("sell-equipment-base-copy")
    const equipmentId = 4050030
    addEquipment(playerId, equipmentId, 0)
    const beforeSoul = getPlayerItemSync(playerId, equipmentId) ?? 0

    const response = await app.inject({
        method: "POST",
        url: "/equipment/sell_equipment",
        payload: { viewer_id: viewerId, equipment_list: [{ equipment_id: equipmentId }] },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerEquipmentSync(playerId, equipmentId), null)
    assert.equal(getPlayerItemSync(playerId, equipmentId), beforeSoul + 1)
})

for (const scenario of [
    {
        name: "sell_equipment",
        equipmentId: 3010006,
        payload: equipmentId => ({ equipment_list: [{ equipment_id: equipmentId }] }),
    },
    {
        name: "sell_stack",
        equipmentId: 3010006,
        payload: equipmentId => ({ equipment_list: [{ equipment_id: equipmentId, number: 1 }] }),
    },
    {
        name: "bulk_sell_stack",
        equipmentId: 3020003,
        payload: equipmentId => ({ equipment_ids: [equipmentId] }),
    },
]) {
    test(`${scenario.name} rolls equipment deduction back when reward grant fails`, async t => {
        const { playerId, viewerId } = await createPlayer(`${scenario.name}-rollback`)
        addEquipment(playerId, scenario.equipmentId, 1)
        const triggerName = `reject_${scenario.name}_reward`
        rejectNextRewardInsert(playerId, triggerName)
        t.after(() => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

        const response = await app.inject({
            method: "POST",
            url: `/equipment/${scenario.name}`,
            payload: { viewer_id: viewerId, ...scenario.payload(scenario.equipmentId) },
        })

        assert.equal(response.statusCode, 500)
        assert.equal(getPlayerEquipmentSync(playerId, scenario.equipmentId).stack, 1)
    })
}

test("equipment protection batch rolls earlier updates back", async t => {
    const { playerId, viewerId } = await createPlayer("protection-rollback")
    addEquipment(playerId, 3010006)
    addEquipment(playerId, 3020003)
    database.exec(`
        CREATE TRIGGER reject_second_protection
        BEFORE UPDATE OF protection ON players_equipment
        WHEN OLD.player_id = ${playerId} AND OLD.id = 3020003
        BEGIN SELECT RAISE(ABORT, 'forced protection failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_second_protection"))

    const response = await app.inject({
        method: "POST",
        url: "/equipment/set_protection",
        payload: {
            viewer_id: viewerId,
            protection: true,
            equipment_ids: [3010006, 3020003],
        },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerEquipmentSync(playerId, 3010006).protection, false)
    assert.equal(getPlayerEquipmentSync(playerId, 3020003).protection, false)
})

test("equipment protection returns the updated equipment projection", async () => {
    const { playerId, viewerId } = await createPlayer("protection-response")
    addEquipment(playerId, 3010006)

    const response = await app.inject({
        method: "POST",
        url: "/equipment/set_protection",
        payload: {
            viewer_id: viewerId,
            protection: true,
            equipment_ids: [3010006],
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    const returned = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    const equipment = returned.data.equipment_list.find(entry => entry.equipment_id === 3010006)
    assert.equal(equipment.protection, true)
})

for (const scenario of [
    { name: "sell_equipment", payload: equipmentId => ({ equipment_list: [{ equipment_id: equipmentId }] }) },
    { name: "sell_stack", payload: equipmentId => ({ equipment_list: [{ equipment_id: equipmentId, number: 1 }] }) },
    { name: "bulk_sell_stack", payload: equipmentId => ({ equipment_ids: [equipmentId] }) },
]) {
    test(`${scenario.name} rejects protected equipment`, async () => {
        const { playerId, viewerId } = await createPlayer(`${scenario.name}-protected`)
        const equipmentId = scenario.name === "bulk_sell_stack" ? 3020003 : 3010006
        addEquipment(playerId, equipmentId, 1, true)

        const response = await app.inject({
            method: "POST",
            url: `/equipment/${scenario.name}`,
            payload: { viewer_id: viewerId, ...scenario.payload(equipmentId) },
        })

        assert.equal(response.statusCode, 400, response.body)
        assert.equal(getPlayerEquipmentSync(playerId, equipmentId).stack, 1)
        assert.equal(getPlayerEquipmentSync(playerId, equipmentId).protection, true)
    })
}
