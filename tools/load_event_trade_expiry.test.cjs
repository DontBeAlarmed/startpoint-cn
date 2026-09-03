"use strict"

const assert = require("node:assert/strict")
const Fastify = require("fastify")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "load-event-trade-expiry-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const beforeExpiry = new Date("2026-01-01T12:00:00.000Z")
const afterExpiry = new Date("2026-01-03T12:00:00.000Z")
const endTimeMs = Date.parse("2026-01-02T00:00:00.000Z")
const VIEWER_ID = 912345678
const EVENT_ITEM_A = 901
const EVENT_ITEM_B = 902
const NO_END_EVENT_ITEM = 904
const NORMAL_ITEM = 903

const config = require("../assets/config.json")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    tableOverrides: {
        "config.json": {
            ...config,
            max_mana: 100,
        },
        "item_inventory_policy.json": {
            byItemId: {
                [EVENT_ITEM_A]: {
                    effectKind: 9,
                    category: 3,
                    salePrice: 2,
                    maxCount: 99,
                    sellable: false,
                    startTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
                    endTimeMs,
                },
                [EVENT_ITEM_B]: {
                    effectKind: 9,
                    category: 3,
                    salePrice: 3,
                    maxCount: 99,
                    sellable: true,
                    startTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
                    endTimeMs,
                },
                [NO_END_EVENT_ITEM]: {
                    effectKind: 9,
                    category: 3,
                    salePrice: 4,
                    maxCount: 99,
                    sellable: false,
                    startTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
                    endTimeMs: null,
                },
                [NORMAL_ITEM]: {
                    effectKind: 0,
                    category: 3,
                    salePrice: 1,
                    maxCount: 99,
                    sellable: true,
                    startTimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
                    endTimeMs,
                },
            },
            eventTradeItemIds: [EVENT_ITEM_A, EVENT_ITEM_B, NO_END_EVENT_ITEM],
        },
    },
})

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { insertDefaultPlayerSync, getPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { setPlayerItemForMaintenanceSync } = require("../src/data/domains/item-maintenance")
const { getTimeOffset, setServerTime, setServerTimeOffset } = require("../src/utils")
const cnLoadRoutes = require("../src/routes/cn/load").default
const previousTimeOffset = getTimeOffset()

async function buildLoadApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        multiMode: "embedded",
    })
    await app.ready()
    return app
}

async function load(app) {
    const response = await app.inject({
        method: "POST",
        url: "/load",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            res_ver: "1.4.54",
        },
        payload: pack({
            viewer_id: VIEWER_ID,
            keychain: VIEWER_ID,
            device_id: 1,
            device_token: "event-trade-expiry-device",
        }).toString("base64"),
    })
    return {
        response,
        payload: response.statusCode === 200
            ? unpack(Buffer.from(response.body, "base64"))
            : null,
    }
}

function openFixture(label, { freeMana = 20, paidMana = 10 } = {}) {
    closeDatabase()
    process.env.DATA_DIR = path.join(databaseRoot, label)
    initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `event-trade-expiry-${label}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(
        String(VIEWER_ID),
        account.id,
        new Date("2099-12-31T23:59:59.000Z").toISOString(),
    )
    updatePlayerSync({
        id: playerId,
        freeMana,
        paidMana,
        lastLoginTime: new Date(),
    })
    return { playerId }
}

function setEventItems(playerId, values) {
    for (const [itemId, amount] of Object.entries(values)) {
        setPlayerItemForMaintenanceSync(playerId, Number(itemId), amount)
    }
}

test.after(() => {
    closeDatabase()
    restoreContentSnapshot()
    setServerTimeOffset(previousTimeOffset)
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("load converts expired EventTrade items atomically and exposes committed post-state", async () => {
    const app = await buildLoadApp()
    try {
        setServerTime(beforeExpiry)
        const { playerId } = openFixture("convert")
        const first = await load(app)
        assert.equal(first.response.statusCode, 200, first.response.body)

        setEventItems(playerId, {
            [EVENT_ITEM_A]: 4,
            [EVENT_ITEM_B]: 5,
            [NO_END_EVENT_ITEM]: 8,
            [NORMAL_ITEM]: 7,
        })
        const before = getPlayerSync(playerId)
        assert.ok(before)
        const expectedMana = 4 * 2 + 5 * 3
        setServerTime(afterExpiry)

        const converted = await load(app)
        assert.equal(converted.response.statusCode, 200, converted.response.body)
        assert.equal(converted.payload.data.item_list[String(EVENT_ITEM_A)], 0)
        assert.equal(converted.payload.data.item_list[String(EVENT_ITEM_B)], 0)
        assert.equal(converted.payload.data.item_list[String(NO_END_EVENT_ITEM)], 8)
        assert.equal(converted.payload.data.item_list[String(NORMAL_ITEM)], 7)
        assert.equal(
            converted.payload.data.user_info.free_mana,
            before.freeMana + expectedMana,
        )
        assert.equal(converted.payload.data.user_info.paid_mana, before.paidMana)

        const after = getPlayerSync(playerId)
        assert.ok(after)
        assert.equal(after.freeMana, before.freeMana + expectedMana)
        assert.equal(after.paidMana, before.paidMana)
        assert.equal(after.totalManaObtained, before.totalManaObtained + expectedMana)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_A), 0)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_B), 0)

        const repeated = await load(app)
        assert.equal(repeated.response.statusCode, 200, repeated.response.body)
        assert.equal(repeated.payload.data.user_info.free_mana, after.freeMana)
        assert.equal(getPlayerSync(playerId).totalManaObtained, after.totalManaObtained)
    } finally {
        await app.close()
    }
})

test("load moves expired EventTrade Mana overflow into Mail when Mana is full", async () => {
    const app = await buildLoadApp()
    try {
        setServerTime(beforeExpiry)
        const { playerId } = openFixture("overflow-deferred", { freeMana: 90, paidMana: 10 })
        const first = await load(app)
        assert.equal(first.response.statusCode, 200, first.response.body)
        setEventItems(playerId, { [EVENT_ITEM_A]: 2, [EVENT_ITEM_B]: 1 })
        setServerTime(afterExpiry)

        const converted = await load(app)
        assert.equal(converted.response.statusCode, 200, converted.response.body)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_A), 0)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_B), 0)
        const convertedPlayer = getPlayerSync(playerId)
        assert.ok(convertedPlayer)
        assert.equal(convertedPlayer.freeMana, 90)
        assert.equal(convertedPlayer.paidMana, 10)
        assert.equal(convertedPlayer.totalManaObtained, 0)
        assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true).map(mail => ({
            type: mail.type,
            type_id: mail.type_id,
            number: mail.number,
        })), [{ type: MailType.FREE_MANA, type_id: null, number: 7 }])

        updatePlayerSync({ id: playerId, freeMana: 80 })
        const retried = await load(app)
        assert.equal(retried.response.statusCode, 200, retried.response.body)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_A), 0)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_B), 0)
        assert.equal(getPlayerSync(playerId).freeMana, 80)
        assert.equal(getPlayerSync(playerId).totalManaObtained, 0)
    } finally {
        await app.close()
    }
})

test("load rolls EventTrade expiry back when the Item owner write fails", async () => {
    const app = await buildLoadApp()
    const triggerName = "reject_event_trade_expiry_item"
    try {
        setServerTime(beforeExpiry)
        const { playerId } = openFixture("rollback", { freeMana: 20, paidMana: 10 })
        const first = await load(app)
        assert.equal(first.response.statusCode, 200, first.response.body)
        setEventItems(playerId, { [EVENT_ITEM_A]: 3, [EVENT_ITEM_B]: 2 })
        const before = getPlayerSync(playerId)
        assert.ok(before)
        getDb().exec(`
            CREATE TRIGGER ${triggerName}
            BEFORE UPDATE OF amount ON players_items
            WHEN NEW.player_id = ${playerId} AND NEW.id = ${EVENT_ITEM_A}
            BEGIN SELECT RAISE(ABORT, 'forced EventTrade expiry failure'); END;
        `)
        setServerTime(afterExpiry)

        const failed = await load(app)
        assert.equal(failed.response.statusCode, 500)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_A), 3)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_B), 2)
        const unchanged = getPlayerSync(playerId)
        assert.ok(unchanged)
        assert.equal(unchanged.freeMana, before.freeMana)
        assert.equal(unchanged.totalManaObtained, before.totalManaObtained)

        getDb().exec(`DROP TRIGGER ${triggerName}`)
        const retried = await load(app)
        assert.equal(retried.response.statusCode, 200, retried.response.body)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_A), 0)
        assert.equal(getPlayerItemSync(playerId, EVENT_ITEM_B), 0)
    } finally {
        try { getDb().exec(`DROP TRIGGER IF EXISTS ${triggerName}`) } catch {}
        await app.close()
    }
})
