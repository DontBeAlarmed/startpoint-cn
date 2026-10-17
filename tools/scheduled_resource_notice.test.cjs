"use strict"

// 自动补货提醒（邮件通道）：
// 1) 发放日首次 load 插入一封无附件信息邮件（subject/description/1 天限时）；
// 2) 同日第二次 load 不再插信（business day 去重）；
// 3) 邮件不再携带 force_news 头、不再写公告行（公告方案已撤）；
// 4) 领取该邮件（number=0 的 FREE_VMONEY）必须无副作用成功——实证零值附件语义。

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
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertScheduledResourceRuleSync } = require("../src/data/domains/scheduled-resource")
const { insertScheduledResourceNoticeMailSync } = require("../src/lib/scheduled-resource-notice-mail")
const cnLoadRoutes = require("../src/routes/cn/load").default

initializeDatabase()

const NOTICE_SUBJECT = "每日资源自动发放"

test("generateDataHeaders 不再默认携带 force_news（公告通道已撤）", () => {
    const headers = generateDataHeaders({ viewer_id: 1 })
    assert.equal(Object.hasOwn(headers, "force_news"), false)
})

test("insertScheduledResourceNoticeMailSync 构建无附件限时信息邮件", () => {
    const playerIdRow = (() => {
        const account = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "test",
            idpId: `notice-builder-${randomUUID()}`,
            status: "normal",
        })
        return insertDefaultPlayerSync(account.id).id
    })()
    insertScheduledResourceRuleSync({
        scope: "player",
        playerId: playerIdRow,
        rewardType: "free_vmoney",
        rewardId: null,
        grantAmount: 1,
        triggerThreshold: 5,
        inventoryCap: 10,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: "体力药水×3+玛纳200",
    })
    const rule = getDb()
        .prepare("SELECT id FROM scheduled_resource_rules WHERE player_id = ?")
        .get(playerIdRow)
    const now = new Date("2024-08-14T08:00:00.000Z")

    const mailId = insertScheduledResourceNoticeMailSync(playerIdRow, [rule.id], now, 5)
    const mail = getDb().prepare("SELECT * FROM players_mails WHERE id = ?").get(mailId)
    assert.equal(mail.subject, NOTICE_SUBJECT)
    assert.equal(mail.reason_id, 0, "reason_id=0 必须命中客户端 Reason 回退路径（渲染服务端原文）")
    assert.match(mail.description, /体力药水×3\+玛纳200/, "正文必须携带规则描述")
    assert.match(mail.description, /发放时间/, "正文必须携带发放时间")
    assert.match(mail.description, /每日 5:00/, "正文必须携带下次补充时间")
    assert.equal(mail.receive_time, "0000-00-00 00:00:00", "初始未领取（红点可见）")
    assert.equal(mail.reward_period_limited, 1)
    const limit = new Date(mail.reward_limit_time.replace(" ", "T") + "Z")
    assert.equal(limit.getTime() - now.getTime(), 24 * 60 * 60 * 1000, "限时必须为 1 天")
    assert.equal(mail.type, 8, "FREE_MANA（玛纳）附件类型")
    assert.equal(mail.number, 1, "附件 = 1 玛纳")
    assert.match(mail.description, /::item::/, "正文必须带附件渲染令牌（与官方 reason 模板一致）")
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

test("load 发放日插邮件且不再携带 force_news 头，同日第二次 load 不重复", async t => {
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
        Object.hasOwn(firstLoad.body.data_headers, "force_news"),
        false,
        "公告通道已撤：load 不得再携带 force_news",
    )
    const mailsAfterFirst = db.prepare(
        "SELECT COUNT(*) AS n FROM players_mails WHERE player_id = ? AND subject = ?",
    ).get(playerId, NOTICE_SUBJECT).n
    assert.equal(mailsAfterFirst, 1, "发放日必须恰好插入一封提醒邮件")

    const secondLoad = await loadOnce()
    assert.equal(secondLoad.response.statusCode, 200)
    const mailsAfterSecond = db.prepare(
        "SELECT COUNT(*) AS n FROM players_mails WHERE player_id = ? AND subject = ?",
    ).get(playerId, NOTICE_SUBJECT).n
    assert.equal(mailsAfterSecond, 1, "同日第二次 load 不得重复插信")
})

test("领取提醒邮件（1 玛纳附件）必须正常到账", async t => {
    const db = getDb()
    // 对齐虚拟时钟到邮件创建日附近，否则领取会按 2004 过期拒绝
    const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
    const previousOffset = getTimeOffset()
    setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())
    t.after(() => setServerTimeOffset(previousOffset))
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `scheduled-notice-claim-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000412
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    const now = new Date("2024-08-14T08:00:00.000Z")
    insertScheduledResourceNoticeMailSync(playerId, [], now, 5)
    const manaBefore = (getDb().prepare("SELECT free_mana AS v FROM players WHERE id = ?").get(playerId) ?? {}).v
    const mailId = db.prepare(
        "SELECT id FROM players_mails WHERE player_id = ? AND subject = ?",
    ).get(playerId, NOTICE_SUBJECT).id

    const mailRoutes = require("../src/routes/api/mail").default
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
    await fastify.register(mailRoutes, { prefix: "/api/index.php/mail" })
    await fastify.ready()
    t.after(() => fastify.close())

    const received = await fastify.inject({
        method: "POST",
        url: "/api/index.php/mail/receive",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({ viewer_id: viewerId, mail_id: mailId }),
    })
    assert.equal(received.statusCode, 200, received.body)
    const manaAfter = (getDb().prepare("SELECT free_mana AS v FROM players WHERE id = ?").get(playerId) ?? {}).v
    assert.equal(manaAfter, manaBefore + 1, "领取必须到账 1 玛纳")
    const remaining = db.prepare(
        "SELECT COUNT(*) AS n FROM players_mails WHERE id = ?",
    ).get(mailId).n
    assert.equal(remaining, 0, "领取后邮件物理删除（官方语义）")
    // 零附件领取不写领取履历（履历只记附件事实）——通知文本阅后即焚，符合设计
})
