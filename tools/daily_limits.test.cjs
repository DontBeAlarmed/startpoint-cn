"use strict";

// R-daily 回归：
// ① 扭蛋每日 one/ten 计数机制——已关闭（2026-10-29 裁定：官服实际卡池 99/99 恒定
//    不递减，该计数为特殊卡池保留设计；普通卡池不设限不递增，crazy 独立上限不受影响）；
// ② 星导石邮件——合并钱包余额+附件 > 999999 统一拒绝（带内 2001 ReceiveError），admin 发送端同口径拦截；
// ③ search_twitter 空响应（合法 200，防 404 踢人）。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-limits-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        additionalTableNames: [
            "gacha.json",
            "gacha_pool.json",
            "gacha_campaign_definitions.json",
            "stars_gacha_campaign.json",
            "gacha_exchange_rate.json",
        ],
    })

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

function cleanup() {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}
process.once("exit", cleanup)

const { setServerTimeOffset } = require("../src/utils")
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())
data.initializeDatabase()
const db = getDb()

let playerSeq = 0
async function createPlayer(label) {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `daily-${label}-${playerSeq}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 870000000 + playerSeq
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}
const decode = r => unpack(Buffer.from(r.body, "base64"))

// ---------- ① 扭蛋每日计数机制：关闭态 ----------

test("gacha daily counters are closed: draws never count and never reject", async () => {
    const { executeGachaDrawSync } = require("../src/lib/gacha-owner/execute")
    const { getPlayerGachaDetailSync } = require("../src/data/domains/gacha-state")

    const { playerId } = await createPlayer("gacha-daily-closed")
    updatePlayerSync({ id: playerId, freeVmoney: 9999999, vmoney: 0 })

    const gachaId = 1638 // bundled 已知活跃角色池（同 gacha_write_transaction）
    const nowMs = Date.parse("2024-08-14T12:00:00.000Z")

    // 跨过旧"上限"（100 次）也必须全部成功——机制已关闭
    for (let i = 0; i < 100; i++) {
        const r = executeGachaDrawSync({
            playerId, gachaId,
            paymentType: 1, execType: 1, numberOfExec: 1, nowMs,
        })
        assert.equal(r.ok, true, `第 ${i + 1} 抽必须成功: ${r.ok ? "" : r.message}`)
    }
    const detail = getPlayerGachaDetailSync(playerId, gachaId)
    assert.equal(detail?.dailyOneCount ?? 0, 0, "单抽计数恒 0（不递增）")
    assert.equal(detail?.dailyTenCount ?? 0, 0, "十连计数恒 0")

    const ten = executeGachaDrawSync({
        playerId, gachaId,
        paymentType: 1, execType: 2, numberOfExec: 1, nowMs,
    })
    assert.equal(ten.ok, true, "十连不受限")
    assert.equal(ten.dailyOneCount, 0, "响应单抽计数恒 0")
    assert.equal(ten.dailyTenCount, 0, "响应十连计数恒 0")
})

test("batch single tickets are unlimited: 10 tickets in one exec pass with counters untouched", async () => {
    const { executeGachaDrawSync } = require("../src/lib/gacha-owner/execute")
    const { getPlayerGachaDetailSync } = require("../src/data/domains/gacha-state")
    const { grantInventoryFixtureItemSync } = require("./helpers/inventory-fixture.cjs")

    const { playerId } = await createPlayer("gacha-batch-unlimited")
    const gachaId = 1638
    const nowMs = Date.parse("2024-08-14T12:00:00.000Z")

    grantInventoryFixtureItemSync(playerId, 999003, 10)
    const batch = executeGachaDrawSync({
        playerId, gachaId,
        paymentType: 3, execType: 10, numberOfExec: 10, nowMs,
    })
    assert.equal(batch.ok, true, `10 张批量单抽券必须成功: ${batch.ok ? "" : batch.message}`)
    assert.equal(batch.dailyOneCount, 0, "响应单抽计数恒 0")
    assert.equal(batch.dailyTenCount, 0, "响应十连计数恒 0")
    const detail = getPlayerGachaDetailSync(playerId, gachaId)
    assert.equal(detail?.dailyOneCount ?? 0, 0, "库内单抽计数恒 0")
})

// ---------- ② 星导石邮件容量 ----------

test("free vmoney mail over capacity is rejected in-band (2001 ReceiveError), aligned with client wallet", async () => {
    const { insertMailSync, getMailArrivedSync } = require("../src/data/domains/mail")
    const { MailType } = require("../src/data/domains/mail")
    const { getCurrencyCapacityPolicySync } = require("../src/lib/config-content")

    const { playerId, viewerId } = await createPlayer("vmoney-mail")
    const maxVmoney = getCurrencyCapacityPolicySync().maxVmoney
    assert.equal(maxVmoney, 999999, "官方免费星导石上限")

    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded", { parseAs: "string" },
        (_r, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_r, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("x-msgpack")) {
            done(null, pack(payload).toString("base64")); return
        }
        done(null, payload)
    })
    const { default: mailRoutes } = require("../src/routes/api/mail")
    await fastify.register(mailRoutes, { prefix: "/api/index.php/mail" })
    await fastify.ready()
    test.after?.(() => fastify.close())

    // 近顶免费余额（差 10）+ 100 星导石邮件 → 超容拒（带内 2001，邮件保留）。
    // 客户端 canGetVirtualMoney 是合并钱包：vmoney + free_vmoney + n <= max。
    updatePlayerSync({ id: playerId, freeVmoney: maxVmoney - 10 })
    const mailId = insertMailSync(playerId, {
        reason_id: 0,
        subject: "capacity test",
        description: null,
        type: MailType.FREE_VMONEY,
        type_id: null,
        number: 100,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2026-07-28 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    })
    const response = await post(fastify, "/api/index.php/mail/receive", {
        viewer_id: viewerId, mail_id: mailId, api_count: 1,
    })
    assert.equal(response.statusCode, 200)
    assert.equal(decode(response).data_headers.result_code, 2001,
        "超容映射白名单 ReceiveError（2001）：客户端站内处理，不回标题")
    assert.equal(getPlayerSync(playerId).freeVmoney, maxVmoney - 10, "拒绝时余额不动")
    const stillThere = db.prepare(
        "SELECT receive_time FROM players_mails WHERE id = ?"
    ).get(mailId)
    assert.equal(stillToReceive(stillThere), true, "邮件保留")

    // 合并钱包判定：付费余额占容量时同样拒（客户端 get_virtualMoney 合并口径）
    updatePlayerSync({ id: playerId, freeVmoney: maxVmoney - 10, vmoney: 50 })
    const paidBlock = await post(fastify, "/api/index.php/mail/receive", {
        viewer_id: viewerId, mail_id: mailId, api_count: 3,
    })
    assert.equal(paidBlock.statusCode, 200)
    assert.equal(decode(paidBlock).data_headers.result_code, 2001,
        "付费余额挤占容量时同样拒绝（合并钱包）")
    assert.equal(getPlayerSync(playerId).freeVmoney, maxVmoney - 10)

    // 正常域：合并钱包腾出空间 + 100 → 领取成功
    updatePlayerSync({ id: playerId, freeVmoney: 0, vmoney: 0 })
    const ok = await post(fastify, "/api/index.php/mail/receive", {
        viewer_id: viewerId, mail_id: mailId, api_count: 2,
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(decode(ok).data_headers.result_code, 1, "成功领取 result_code=1（成功默认值）")
    assert.equal(getPlayerSync(playerId).freeVmoney, 100)
})

function stillToReceive(row) {
    return row?.receive_time === "0000-00-00 00:00:00"
}

// ---------- ③ search_twitter 空响应 ----------

test("follow/search_twitter answers an empty list (not 404)", async () => {
    const { playerId, viewerId } = await createPlayer("twitter")
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded", { parseAs: "string" },
        (_r, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_r, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("x-msgpack")) {
            done(null, pack(payload).toString("base64")); return
        }
        done(null, payload)
    })
    const { registerFollowReadRoutes } = require("../src/routes/api/follow/read-routes")
    await fastify.register(async instance => {
        registerFollowReadRoutes(instance)
    }, { prefix: "/api/index.php/follow" })
    await fastify.ready()

    const response = await post(fastify, "/api/index.php/follow/search_twitter", {
        viewer_id: viewerId, twitter_follow_ids: [],
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(decode(response).data.twitter_follow_ids, [])
    await fastify.close()
})
