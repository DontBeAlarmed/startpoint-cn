"use strict"

// 自动补货提醒三件套：
// 1) generateDataHeaders 默认携带 force_news=0（全响应统一头）；
// 2) news 常驻公告行 find-or-create + 同日幂等 + 跨日原地更新（列表恒一行）；
// 3) /load 在 scheduled-resource 发放日置 force_news=2，同日第二次 load 不再置位
//    （客户端主页到达弹公告列表后自清 flag，每日至多一次）。

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-notice-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { generateDataHeaders } = require("../src/utils")
const { ensureScheduledResourceNoticeSync } = require("../src/data/domains/news")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertScheduledResourceRuleSync } = require("../src/data/domains/scheduled-resource")
const cnLoadRoutes = require("../src/routes/cn/load").default

initializeDatabase()

const NOTICE_TITLE = "【系统】每日资源自动发放"

test("generateDataHeaders 默认带 force_news=0 且可覆盖", () => {
    const headers = generateDataHeaders({ viewer_id: 1 })
    assert.equal(headers.force_news, 0, "全响应统一头必须包含 force_news（0 为惰性值）")
    assert.equal(generateDataHeaders({ force_news: 2 }).force_news, 2)
    assert.equal(generateDataHeaders({ force_news: 1 }).force_news, 1)
})

test("ensureScheduledResourceNoticeSync 幂等创建、同日不递增、跨日原地更新", () => {
    const now = new Date("2024-08-14T08:00:00.000Z")
    const first = ensureScheduledResourceNoticeSync(now)
    assert.equal(first.title, NOTICE_TITLE)
    assert.equal(first.revision, 1)
    const sameDay = ensureScheduledResourceNoticeSync(now)
    assert.equal(sameDay.id, first.id)
    assert.equal(sameDay.revision, 1, "同日重复调用必须幂等（不递增 revision）")
    const rowsAfterSameDay = getDb()
        .prepare("SELECT COUNT(*) AS n FROM server_news WHERE title = ?")
        .get(NOTICE_TITLE).n
    assert.equal(rowsAfterSameDay, 1, "列表恒一行，不得随发放日增")

    const nextDay = ensureScheduledResourceNoticeSync(new Date("2024-08-16T08:00:00.000Z"))
    assert.equal(nextDay.id, first.id, "跨日必须原地更新同一行")
    assert.equal(nextDay.revision, 2)
    assert.equal(nextDay.publishedAtReal, "2024-08-16T08:00:00.000Z")

    const dayThree = ensureScheduledResourceNoticeSync(new Date("2024-08-17T08:00:00.000Z"))
    assert.equal(dayThree.revision, 3)
    const rowsAfterThreeDays = getDb()
        .prepare("SELECT COUNT(*) AS n FROM server_news WHERE title = ?")
        .get(NOTICE_TITLE).n
    assert.equal(rowsAfterThreeDays, 1)
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

test("load 在发放日置 force_news=2，同日第二次 load 回落为 0", async t => {
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `scheduled-notice-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000411
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    // 初始 freeVmoney=4 < 阈值 5000 → 首次 load 发放 +9999（≥阈值）→ 同日第二次不再发放；
    // 阈值取高是为隔离 load 前置结算（登录奖励等）对 freeVmoney 的抬升噪声
    updatePlayerSync({ id: playerId, stamina: 100, totalStaminaUsed: 0, totalDashes: 0, freeVmoney: 4 })
    insertScheduledResourceRuleSync({
        scope: "player",
        playerId,
        rewardType: "free_vmoney",
        rewardId: null,
        grantAmount: 9999,
        triggerThreshold: 5000,
        inventoryCap: 20000,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: "test daily restock",
    })

    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(cnLoadRoutes, { assetProvider: { mode: "client-owned" } })
    await fastify.ready()
    t.after(() => fastify.close())

    const loadOnce = async () => {
        const response = await fastify.inject({
            method: "POST",
            url: "/load",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                keychain: viewerId,
                device_id: 1,
                device_token: "test",
            }),
        })
        return { response, body: decodeResponse(response) }
    }

    const firstLoad = await loadOnce()
    assert.equal(firstLoad.response.statusCode, 200, JSON.stringify(firstLoad.body).slice(0, 200))
    assert.equal(
        firstLoad.body.data_headers.force_news, 2,
        "发放日的首次 load 必须置 force_news=2（主页公告提醒）",
    )
    assert.ok(getDb()
        .prepare("SELECT id FROM server_news WHERE title = ?")
        .get(NOTICE_TITLE), "发放必须同步维护常驻公告行")

    const secondLoad = await loadOnce()
    assert.equal(secondLoad.response.statusCode, 200)
    assert.equal(
        secondLoad.body.data_headers.force_news, 0,
        "同日已发放（无新发放）不得再置位——提醒每日至多一次",
    )
})
