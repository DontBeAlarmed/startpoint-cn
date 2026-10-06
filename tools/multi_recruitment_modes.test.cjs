"use strict"

// 批次一（三模式机械层）综合回归：
// - 设置域四参数：默认值 = NPC 快速预设、更新回路、校验拒绝
// - web_api PATCH：多字段原子保存、单字段向后兼容、未知字段拒绝、
//   W+60s 余量超房间寿命拒绝（运行时 env）、publishBell on→off 真转换才清扫
// - store 扩展：findOpenRecruitmentForRoom / closeAllOpenRecruitments /
//   hasActiveDelivery（delivered/accepted 持票，declined 无票）
// - 过期复活修复：过期招募行被重发时创建全新行（新 key/新 posted_at）
// - summon 三模式语义纯函数 resolveSummonServeCandidates
// - T2 门票：resolveBellRecruitmentForStart 要求有效投递行

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recruitment-modes-"))
process.env.WDFP_DATABASE_DIR = dir
let db

function cleanup() {
    if (db?.open) db.close()
    restore()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
initializeDatabase()
db = getDb()

const {
    getServerGameplaySettingsSync,
    updateServerGameplaySettingsSync,
} = require("../src/data/domains/server-settings")
const {
    closeAllOpenRecruitments,
    findOpenRecruitmentForRoom,
    getOrCreateRecruitmentForRoom,
    hasActiveDelivery,
} = require("../src/data/domains/attention")
const { resolveSummonServeCandidates } = require("../src/multi/http/room")
const { resolveBellRecruitmentForStart } = require("../src/multi/http/battle")
const { deliverOpenRecruitmentsToViewer } = require("../src/data/domains/attention")

const HOST_VIEWER = 9701
const ROOM = "135790"
const nowMs = Date.now()

function shareRoom(overrides = {}) {
    return getOrCreateRecruitmentForRoom({
        hostPid: 701,
        hostViewerId: HOST_VIEWER,
        category: 1,
        questId: 1001001,
        roomNumber: ROOM,
        isNewbieHost: true,
        establisherJson: "{}",
        nowMs,
        ...overrides,
    })
}

// ---- 设置域：默认值 = NPC 快速预设 ----
{
    const settings = getServerGameplaySettingsSync()
    assert.equal(settings.multiRandomRecruitmentPublishEnabled, false, "默认不发布铃铛（NPC 快速预设）")
    assert.equal(settings.multiNpcReleaseSeconds, 0)
    assert.equal(settings.multiNpcCloseRecruitmentAfterFill, true)
    assert.equal(settings.multiNpcOneShotLifecycle, false)
}

// ---- 设置域：更新回路 + 校验 ----
{
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 90,
        multiNpcCloseRecruitmentAfterFill: false,
        multiNpcOneShotLifecycle: true,
    })
    const settings = getServerGameplaySettingsSync()
    assert.equal(settings.multiRandomRecruitmentPublishEnabled, true)
    assert.equal(settings.multiNpcReleaseSeconds, 90)
    assert.equal(settings.multiNpcCloseRecruitmentAfterFill, false)
    assert.equal(settings.multiNpcOneShotLifecycle, true)

    assert.throws(
        () => updateServerGameplaySettingsSync({
            dropMultiplier: settings.dropMultiplier,
            multiNpcReleaseSeconds: -1,
        }),
        /release seconds/,
    )
    assert.throws(
        () => updateServerGameplaySettingsSync({
            dropMultiplier: settings.dropMultiplier,
            multiNpcReleaseSeconds: 1.5,
        }),
        /release seconds/,
    )
    assert.throws(
        () => updateServerGameplaySettingsSync({
            dropMultiplier: settings.dropMultiplier,
            multiRandomRecruitmentPublishEnabled: "yes",
        }),
        /publish setting/,
    )
}

// ---- store 扩展：findOpenRecruitmentForRoom / closeAllOpen / hasActiveDelivery ----
{
    db.prepare("DELETE FROM attention_recruitments").run()
    db.prepare("DELETE FROM attention_deliveries").run()
    const recruitment = shareRoom()

    const found = findOpenRecruitmentForRoom(HOST_VIEWER, ROOM, nowMs)
    assert.ok(found !== null && found.id === recruitment.id)

    assert.equal(findOpenRecruitmentForRoom(9999, ROOM, nowMs), null, "他人房间不命中")
    assert.equal(findOpenRecruitmentForRoom(HOST_VIEWER, "000000", nowMs), null)

    // 过期 → null
    db.prepare("UPDATE attention_recruitments SET expires_at_ms = ? WHERE id = ?")
        .run(nowMs - 1, recruitment.id)
    assert.equal(findOpenRecruitmentForRoom(HOST_VIEWER, ROOM, nowMs), null, "过期行不命中")

    // 关闭 → null
    db.prepare("UPDATE attention_recruitments SET expires_at_ms = ?, status = 'closed' WHERE id = ?")
        .run(nowMs + 1000, recruitment.id)
    assert.equal(findOpenRecruitmentForRoom(HOST_VIEWER, ROOM, nowMs), null, "关闭行不命中")

    // closeAllOpenRecruitments
    const a = shareRoom({ roomNumber: "246801", nowMs: nowMs + 1 })
    const b = shareRoom({ hostViewerId: 9702, hostPid: 702, roomNumber: "246802", nowMs: nowMs + 1 })
    closeAllOpenRecruitments()
    for (const id of [a.id, b.id, recruitment.id]) {
        assert.equal(
            db.prepare("SELECT status FROM attention_recruitments WHERE id = ?").get(id).status,
            "closed",
        )
    }

    // hasActiveDelivery：delivered/accepted 持票，declined/缺失无票
    db.prepare("UPDATE attention_recruitments SET status = 'open' WHERE id = ?").run(a.id)
    const guest = 9800
    const bells = deliverOpenRecruitmentsToViewer(guest, nowMs + 2, 3)
    assert.equal(bells.length, 1)
    assert.equal(hasActiveDelivery(a.id, guest), true, "delivered 持票")
    assert.equal(hasActiveDelivery(a.id, 9999), false, "无投递行无票")
    const { recordResponse } = require("../src/data/domains/attention")
    recordResponse(a.id, guest, "accepted", nowMs + 3)
    assert.equal(hasActiveDelivery(a.id, guest), true, "accepted 仍持票")
    // declined 需从 delivered 转移——accepted 行是单向终态，不能降级（设计语义）
    const c = shareRoom({ hostViewerId: 9703, hostPid: 703, roomNumber: "246803", nowMs: nowMs + 4 })
    const guestC = 9801
    deliverOpenRecruitmentsToViewer(guestC, nowMs + 5, 3)
    recordResponse(c.id, guestC, "declined", nowMs + 6)
    assert.equal(hasActiveDelivery(c.id, guestC), false, "declined 无票")
}

// ---- 过期复活修复：过期行重发 = 全新行（新 key/新 posted_at） ----
{
    db.prepare("DELETE FROM attention_recruitments").run()
    db.prepare("DELETE FROM attention_deliveries").run()
    const first = shareRoom({ nowMs })
    db.prepare("UPDATE attention_recruitments SET expires_at_ms = ? WHERE id = ?")
        .run(nowMs - 1, first.id)
    const revived = shareRoom({ nowMs: nowMs + 1000 })
    assert.equal(revived.created, true, "过期行重发必须创建新行")
    assert.notEqual(revived.id, first.id)
    assert.notEqual(revived.attentionKey, first.attentionKey, "复活不得复用旧 key")
    const row = db.prepare("SELECT posted_at_ms FROM attention_recruitments WHERE id = ?").get(revived.id)
    assert.equal(row.posted_at_ms, nowMs + 1000, "新行窗口起点必须刷新")
}

// ---- summon 三模式语义纯函数 ----
{
    const base = { nowMs: 100_000 }
    assert.equal(resolveSummonServeCandidates({
        ...base, publishEnabled: false, releaseSeconds: 90, recruitment: null,
    }), true, "NPC 快速：恒发候选")
    assert.equal(resolveSummonServeCandidates({
        ...base, publishEnabled: true, releaseSeconds: 0, recruitment: null,
    }), true, "官服（W=0）：恒发候选（客户端 ~20s 原生时序）")
    assert.equal(resolveSummonServeCandidates({
        ...base, publishEnabled: true, releaseSeconds: 90, recruitment: null,
    }), false, "混合：行缺失回空（注入批次三负责释放）")
    assert.equal(resolveSummonServeCandidates({
        ...base, publishEnabled: true, releaseSeconds: 90,
        recruitment: { postedAtMs: 100_000 - 89_000 },
    }), false, "混合：窗口未到回空")
    assert.equal(resolveSummonServeCandidates({
        ...base, publishEnabled: true, releaseSeconds: 90,
        recruitment: { postedAtMs: 100_000 - 90_000 },
    }), true, "混合：窗口已过发候选")
}

// ---- T2 门票 ----
{
    db.prepare("DELETE FROM attention_recruitments").run()
    db.prepare("DELETE FROM attention_deliveries").run()
    const recruitment = shareRoom({ nowMs })
    const guest = 9810
    assert.equal(
        resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, guest),
        null,
        "无投递行的 key 是伪造票",
    )
    deliverOpenRecruitmentsToViewer(guest, nowMs + 1, 3)
    const matched = resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, guest)
    assert.ok(matched !== null && matched.id === recruitment.id, "delivered 持票进房")
    const { recordResponse } = require("../src/data/domains/attention")
    recordResponse(recruitment.id, guest, "declined", nowMs + 2)
    assert.equal(
        resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, guest),
        null,
        "declined 无票",
    )
    assert.equal(
        resolveBellRecruitmentForStart(recruitment.attentionKey, "999999", HOST_VIEWER, guest),
        null,
        "跨房间拒绝（既有语义不变）",
    )
}

// ---- web_api PATCH：多字段原子保存 / 未知字段拒绝 / W 运行时校验 / 清扫 ----
async function main() {
    const fastify = Fastify({ logger: false })
    const { default: settingsApiPlugin } = require("../src/routes/web_api/settings")
    await fastify.register(settingsApiPlugin, { prefix: "/server/settings" })
    await fastify.ready()
    const patch = payload => fastify.inject({ method: "PATCH", url: "/server/settings/gameplay", payload })
    const previousExpiryEnv = process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS

    try {
        db.prepare("DELETE FROM attention_recruitments").run()
        db.prepare("DELETE FROM attention_deliveries").run()

        // 多字段原子保存（官服预设四字段一次提交）
        const official = await patch({
            multiRandomRecruitmentPublishEnabled: true,
            multiNpcReleaseSeconds: 0,
            multiNpcCloseRecruitmentAfterFill: true,
            multiNpcOneShotLifecycle: true,
        })
        assert.equal(official.statusCode, 200, official.body)
        let settings = getServerGameplaySettingsSync()
        assert.equal(settings.multiRandomRecruitmentPublishEnabled, true)
        assert.equal(settings.multiNpcOneShotLifecycle, true)

        // 单字段向后兼容
        const single = await patch({ dropMultiplier: 5 })
        assert.equal(single.statusCode, 200)
        assert.equal(getServerGameplaySettingsSync().dropMultiplier, 5)

        // 未知字段拒绝（新契约：已知+未知混合同样 400）
        assert.equal((await patch({ dropMultiplier: 2, unexpected: true })).statusCode, 400)
        assert.equal((await patch({ unexpected: true })).statusCode, 400)

        // W 运行时校验：env 寿命 120s → W=120（+60s 余量）拒绝、W=59 接受
        process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS = "120000"
        assert.equal((await patch({ multiNpcReleaseSeconds: 120 })).statusCode, 400)
        assert.equal((await patch({ multiNpcReleaseSeconds: 59 })).statusCode, 200)
        delete process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS

        // 清扫：publish on→off 真转换关闭全部 open 招募；off→off 不触发（本就无行）
        shareRoom({ nowMs: Date.now(), roomNumber: "555001" })
        assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM attention_recruitments WHERE status = 'open'").get().n,
            1,
        )
        const swept = await patch({ multiRandomRecruitmentPublishEnabled: false })
        assert.equal(swept.statusCode, 200)
        assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM attention_recruitments WHERE status = 'open'").get().n,
            0,
            "on→off 必须清扫全部 open 招募",
        )
        const again = await patch({ multiRandomRecruitmentPublishEnabled: false })
        assert.equal(again.statusCode, 200)

        // off→on 不清扫
        updateServerGameplaySettingsSync({
            dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
            multiRandomRecruitmentPublishEnabled: true,
        })
        shareRoom({ nowMs: Date.now(), roomNumber: "555002" })
        const onAgain = await patch({ multiRandomRecruitmentPublishEnabled: true })
        assert.equal(onAgain.statusCode, 200)
        assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM attention_recruitments WHERE status = 'open'").get().n,
            1,
            "off→on 不得清扫",
        )
    } finally {
        if (previousExpiryEnv === undefined) delete process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS
        else process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS = previousExpiryEnv
        await fastify.close()
    }

    console.log("multi recruitment modes (batch one): all assertions passed")
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
