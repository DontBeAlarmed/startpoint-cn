require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pass-card-purchase-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerPassCardStateSync } = require("../src/data/domains/pass-card")
const { getPlayerShopPurchaseCountsByTypeSync } = require("../src/data/domains/shopPurchase")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const paymentRoutes = require("../src/routes/api/payment").default
const shopRoutes = require("../src/routes/api/shop").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const { pack } = require("msgpackr")
const { getPassCardEventDefinition } = require("../src/lib/pass-card")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `pass-card-purchase-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000221
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, "2099-12-31T23:59:59.000Z", 2)

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(paymentRoutes, { prefix: "/payment" })
    await fastify.register(shopRoutes, { prefix: "/shop" })
    await fastify.ready()

    try {
        const itemListResponse = await fastify.inject({
            method: "POST",
            url: "/payment/item_list",
            payload: { viewer_id: viewerId },
        })
        assert.equal(itemListResponse.statusCode, 200, itemListResponse.body)

        const itemListData = require("msgpackr").unpack(itemListResponse.rawPayload).data
        const activeEvent = getPassCardEventDefinition(3)
        assert.ok(activeEvent)
        assert.deepEqual(itemListData.payment_item_list, [{
            store_product_id: "com.leiting.wf.pass_card",
            age_limit: false,
            monthly_alert: false,
            purchased_times: null,
            start_time: activeEvent.startTime / 1000,
            end_time: activeEvent.endTime / 1000,
        }])

        const before = getPlayerSync(playerId)
        const initialVmoney = before.vmoney
        const initialFreeVmoney = before.freeVmoney

        const startResponse = await fastify.inject({
            method: "POST",
            url: "/payment/start",
            payload: {
                viewer_id: viewerId,
                payment: { product_id: "com.leiting.wf.pass_card" },
            },
        })
        assert.equal(startResponse.statusCode, 200, startResponse.body)

        const finish = () => fastify.inject({
            method: "POST",
            url: "/payment/finish",
            payload: {
                viewer_id: viewerId,
                receipt: "private-server-pass-card-test",
            },
        })

        const firstResponse = await finish()
        assert.equal(firstResponse.statusCode, 200, firstResponse.body)
        assert.equal(getPlayerPassCardStateSync(playerId, 3).isBuy, true)
        assert.equal(getPlayerSync(playerId).vmoney, initialVmoney)
        assert.equal(getPlayerSync(playerId).freeVmoney, initialFreeVmoney)

        const secondResponse = await finish()
        assert.equal(secondResponse.statusCode, 200, secondResponse.body)
        assert.equal(getPlayerPassCardStateSync(playerId, 3).isBuy, true)
        assert.equal(getPlayerSync(playerId).vmoney, initialVmoney)
        assert.equal(getPlayerSync(playerId).freeVmoney, initialFreeVmoney)

        const pointBeforeGift = getPlayerPassCardStateSync(playerId, 3).point
        const vmoneyBeforeGift = getPlayerSync(playerId).vmoney
        const giftResponse = await fastify.inject({
            method: "POST",
            url: "/shop/buy",
            payload: {
                viewer_id: viewerId,
                shop_type: 3,
                shop_item_id: 220040,
                number: 1,
            },
        })
        assert.equal(giftResponse.statusCode, 200, giftResponse.body)
        assert.equal(getPlayerPassCardStateSync(playerId, 3).point, pointBeforeGift + 100)
        assert.equal(getPlayerSync(playerId).vmoney, vmoneyBeforeGift - 50)
        assert.equal(
            getPlayerShopPurchaseCountsByTypeSync(playerId, 3, 220040, {
                daily: "2024-08-14",
                monthly: "2024-08",
            }).total,
            1,
        )

        setServerTimeOffset(Date.parse("2024-10-01T12:00:00.000Z") - Date.now())
        await fastify.inject({
            method: "POST",
            url: "/payment/start",
            payload: {
                viewer_id: viewerId,
                payment: { product_id: "com.leiting.wf.pass_card" },
            },
        })
        const expiredResponse = await finish()
        assert.equal(expiredResponse.statusCode, 200, expiredResponse.body)
        assert.equal(getPlayerPassCardStateSync(playerId, 3).isBuy, true)
        assert.equal(getPlayerPassCardStateSync(playerId, 4).isBuy, false)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("pass card purchase route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
