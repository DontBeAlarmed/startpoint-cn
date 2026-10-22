"use strict"

// R-03 经济请求级幂等集成回归（gacha/exec 载体）：
// 同 (playerId, api_count, 端点) 重试 → 回放同一响应且业务只执行一次；
// 不同计数 → 照常执行；端点隔离 → 不串。

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "economy-idem-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: [
        "gacha.json",
        "gacha_pool.json",
        "gacha_campaign_definitions.json",
        "stars_gacha_campaign.json",
        "gacha_exchange_rate.json",
    ],
})
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { grantInventoryFixtureItemSync } = require("./helpers/inventory-fixture.cjs")
const { resetEconomyResponseCacheForTest } = require("../src/lib/economy-response-cache")
const gachaRoutes = require("../src/routes/api/gacha").default

const TICKET = 70030
const GACHA_ID = 1613

function getPlayerItemSync(playerId, itemId) {
    const row = getDb().prepare(
        "SELECT amount FROM players_items WHERE player_id = ? AND id = ?",
    ).get(playerId, itemId)
    return row?.amount ?? null
}

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeBody(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

async function buildApp() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    // 生产同款 msgpack onSend（识别 pendingEncoder 透传——回放机制依赖它）
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    registerCnMsgpackOnSend(fastify)
    const { registerEconomyIdempotency } = require("../src/routes/api/economy-idempotency")
    // 直调（非 app.register）：钩子必须挂在根实例上才能覆盖兄弟路由插件
    // （Fastify 封装模型：register 的插件实例是隔离作用域）
    await registerEconomyIdempotency(fastify, { prefix: "/api/index.php/gacha" })
    await fastify.register(gachaRoutes, {
        prefix: "/api/index.php/gacha",
        assetProvider: { mode: "client-owned" },
    })
    await fastify.ready()
    return fastify
}

async function execGacha(fastify, viewerId, apiCount) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/gacha/exec",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            gacha_id: GACHA_ID,
            payment_type: 3,
            number_of_exec: 1,
            type: 4,
            api_count: apiCount,
        }),
    })
}

test("同 api_count 重试回放同一响应且业务只执行一次；异计数照常执行", async t => {
    initializeDatabase()
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `economy-idem-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000601
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    grantInventoryFixtureItemSync(playerId, TICKET, 2)
    updatePlayerSync({ id: playerId, stamina: 100, totalStaminaUsed: 0, totalDashes: 0 })

    const fastify = await buildApp()
    t.after(() => fastify.close())

    // 首次执行：扣一张券
    const first = await execGacha(fastify, viewerId, 1)
    assert.equal(first.statusCode, 200, first.body)
    const firstBody = decodeBody(first)
    const ticketsAfterFirst = getPlayerItemSync(playerId, TICKET)
    assert.equal(ticketsAfterFirst, 1, "首次执行扣一张券")

    // 同 api_count 重试：回放同一响应体，库存不再扣减
    const retry = await execGacha(fastify, viewerId, 1)
    assert.equal(retry.statusCode, 200)
    const retryBody = decodeBody(retry)
    assert.deepEqual(retryBody.data, firstBody.data, "重试必须回放同一响应")
    assert.equal(getPlayerItemSync(playerId, TICKET), ticketsAfterFirst, "重试不得再次扣费")

    // 不同 api_count：照常执行（第二张券扣减，结果独立）
    const second = await execGacha(fastify, viewerId, 2)
    assert.equal(second.statusCode, 200, second.body)
    assert.equal(getPlayerItemSync(playerId, TICKET), 0, "第二张券正常扣减")

    // 端点隔离：同计数不同端点视为未命中（防跨端点误回放）
    resetEconomyResponseCacheForTest()
    const result = require("../src/lib/economy-response-cache")
    result.rememberEconomyResponse(playerId, 7, "/api/index.php/gacha/exec", '{"x":1}')
    assert.notEqual(result.findEconomyReplay(playerId, 7, "/api/index.php/gacha/exec"), null, "同端点命中")
    assert.equal(result.findEconomyReplay(playerId, 7, "/api/index.php/other"), null, "异端点未命中")
})

test("登录世代推进后同计数不回放、业务照常执行（跨会话误回放修复）", async t => {
    initializeDatabase()
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `economy-gen-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000602
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    grantInventoryFixtureItemSync(playerId, TICKET, 2)
    updatePlayerSync({ id: playerId, stamina: 100, totalStaminaUsed: 0, totalDashes: 0 })

    const fastify = await buildApp()
    t.after(() => fastify.close())

    // 旧会话：api_count=1 执行并缓存
    const first = await execGacha(fastify, viewerId, 1)
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(getPlayerItemSync(playerId, TICKET), 1, "旧会话首次执行扣一张券")

    // 重登（signup bump 世代）：客户端 api_count 归零后重新从 1 计数——
    // 同计数同端点必须执行业务而不是回放旧响应
    const { bumpEconomyGenerationForPlayer } = require("../src/lib/economy-response-cache")
    bumpEconomyGenerationForPlayer(playerId)
    const relogin = await execGacha(fastify, viewerId, 1)
    assert.equal(relogin.statusCode, 200, relogin.body)
    assert.equal(getPlayerItemSync(playerId, TICKET), 0, "新世代同计数必须照常执行（再扣一张）")
    const reloginBody = decodeBody(relogin)
    const firstBody = decodeBody(first)
    assert.notDeepEqual(reloginBody.data, firstBody.data, "新世代响应必须是新执行结果而非回放")

    // 同世代内重试仍回放（世代不清除会话内幂等语义）
    const retry = await execGacha(fastify, viewerId, 1)
    assert.deepEqual(decodeBody(retry).data, reloginBody.data, "同世代重试照常回放")
    assert.equal(getPlayerItemSync(playerId, TICKET), 0, "重试不再扣费")
})

test("世代 Map 随 sweep 回收无条目引用的键（R-F01）", async () => {
    initializeDatabase()
    const result = require("../src/lib/economy-response-cache")
    result.resetEconomyResponseCacheForTest()

    // 无条目玩家的世代 bump 后：任一 remember 触发 sweep 即回收
    result.bumpEconomyGenerationForPlayer(990001)
    result.bumpEconomyGenerationForPlayer(990002)
    result.rememberEconomyResponse(990003, 1, "/api/index.php/gacha/exec", "{}")
    assert.equal(result.economyGenerationSizeForTest().has(990001), false,
        "无条目引用的世代键必须在 sweep 后回收")
    assert.equal(result.economyGenerationSizeForTest().has(990002), false,
        "无条目引用的世代键必须在 sweep 后回收")
    // 有条目的玩家世代保留（其回放语义依赖它）
    assert.equal(result.economyGenerationSizeForTest().has(990003), true,
        "有条目引用的世代键不得被回收")
    result.resetEconomyResponseCacheForTest()
})
