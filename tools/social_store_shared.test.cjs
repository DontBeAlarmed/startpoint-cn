"use strict"

// A2 共享社交库集成回归：MULTI_SOCIAL_DB_PATH 指向共享 SQLite 文件时，
// 铃铛招募（attention 两表）与 presence（social_presence 表）可在多个独立
// 连接（模拟多进程/多节点）间平等读写——无主客身份。
// 语义基线：读时惰性投递、accepted 单向收敛、close 跨连接可见、
// presence touch 30s 节流 + 5min 窗口 + 惰性清扫。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-store-shared-"))
const sharedPath = path.join(dir, "social.db")
process.env.MULTI_SOCIAL_DB_PATH = sharedPath

const {
    openSharedSocialDb,
    getSharedSocialDb,
    resetSharedSocialDbForTest,
} = require("../src/data/social/shared-db")
const {
    createSqliteAttentionStore,
    getAttentionStore,
    getOrCreateRecruitmentForRoom,
    deliverOpenRecruitmentsToViewer,
    findOpenRecruitmentByKey,
} = require("../src/data/domains/attention")
const {
    createSqlitePresenceStore,
    touchPresence,
    isPresenceOnline,
    PRESENCE_THROTTLE_MS,
    PRESENCE_WINDOW_MS,
} = require("../src/multi/presence")

let dbA
let dbB
function cleanup() {
    resetSharedSocialDbForTest()
    if (dbA?.open) dbA.close()
    if (dbB?.open) dbB.close()
    fs.rmSync(dir, { recursive: true, force: true })
}
process.once("exit", cleanup)

// ---- env 工厂：共享库生效 + WAL ----
{
    const shared = getSharedSocialDb()
    assert.ok(shared !== null, "设置 MULTI_SOCIAL_DB_PATH 后必须返回共享库连接")
    assert.equal(shared.open, true)
    assert.equal(
        shared.pragma("journal_mode", { simple: true }),
        "wal",
        "共享库必须 WAL（多连接读写并发前提）",
    )
    assert.equal(
        shared.pragma("busy_timeout", { simple: true }),
        5000,
        "共享库必须设置 busy_timeout（跨进程写竞争排队）",
    )
    for (const table of ["attention_recruitments", "attention_deliveries", "social_presence"]) {
        const row = shared.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)
        assert.ok(row !== undefined, `共享库必须初始化 ${table}`)
    }
}

// ---- 双连接（模拟双进程）：社交闭环跨连接可见 ----
{
    dbA = openSharedSocialDb(sharedPath)
    dbB = openSharedSocialDb(sharedPath)
    const storeA = createSqliteAttentionStore(dbA)
    const storeB = createSqliteAttentionStore(dbB)
    const presA = createSqlitePresenceStore(dbA)
    const presB = createSqlitePresenceStore(dbB)

    const t0 = 5_000_000
    const HOST_VIEWER = 7001
    const GUEST_VIEWER = 7002

    // 进程 A（房主节点）：开招募
    const created = storeA.getOrCreateRecruitmentForRoom({
        hostPid: 301,
        hostViewerId: HOST_VIEWER,
        category: 1,
        questId: 1001001,
        roomNumber: "510001",
        isNewbieHost: true,
        establisherJson: "{}",
        nowMs: t0,
    })
    assert.equal(created.created, true)

    // 进程 B（guest 节点）：轮询投递可见（读时惰性投递跨连接成立）
    const bells = storeB.deliverOpenRecruitmentsToViewer(GUEST_VIEWER, t0 + 1, 3)
    assert.equal(bells.length, 1, "进程 B 必须看到进程 A 创建的招募")
    assert.equal(bells[0].attentionKey, created.attentionKey)
    assert.equal(bells[0].roomNumber, "510001")

    // 进程 B：key 解析可见（quest/start 跨节点进房依据）
    const resolved = storeB.findOpenRecruitmentByKey(created.attentionKey, t0 + 2)
    assert.ok(resolved !== null)
    assert.equal(resolved.hostViewerId, HOST_VIEWER)

    // 进程 B：accepted 后，进程 A 侧也收敛（投递状态共享）
    storeB.recordResponse(created.id, GUEST_VIEWER, "accepted", t0 + 3)
    assert.equal(
        storeA.deliverOpenRecruitmentsToViewer(GUEST_VIEWER, t0 + 4, 3).length,
        0,
        "进程 B 的 accepted 必须对进程 A 可见（不再投递）",
    )

    // 进程 A：解散关招募 → 进程 B key 解析失效
    storeA.closeRecruitmentForRoom(HOST_VIEWER, "510001")
    assert.equal(storeB.findOpenRecruitmentByKey(created.attentionKey, t0 + 5), null,
        "进程 A 关闭的招募必须对进程 B 立即失效")

    // 双侧跨连接写入均落库（同线程顺序执行，不构成真实写锁竞争——
    // 真实多进程竞争验证待部署侧，见 docs/systems/multi-social-store.md 边界）
    const left = storeA.getOrCreateRecruitmentForRoom({
        hostPid: 1, hostViewerId: 7101, category: 1, questId: 1001001,
        roomNumber: "520001", isNewbieHost: false, establisherJson: "{}", nowMs: t0 + 10,
    })
    const right = storeB.getOrCreateRecruitmentForRoom({
        hostPid: 2, hostViewerId: 7102, category: 1, questId: 1001001,
        roomNumber: "520002", isNewbieHost: false, establisherJson: "{}", nowMs: t0 + 10,
    })
    assert.equal(left.created && right.created, true, "双侧并发 get-or-create 都必须成功")
    assert.equal(
        dbA.prepare("SELECT COUNT(*) AS n FROM attention_recruitments WHERE room_number IN ('520001','520002')").get().n,
        2,
    )

    // ---- presence 表化：跨连接可见 + 节流 + 窗口 + 清扫 ----
    presA.touch(8001, t0)
    assert.equal(presB.isOnline(8001, t0 + 1), true, "进程 A touch 必须对进程 B 在线可见")
    assert.deepEqual(presB.onlineViewerIds(t0 + 1).includes(8001), true)

    // 30s 节流：节流窗口内的第二次 touch 不刷新 last_seen
    presA.touch(8001, t0 + PRESENCE_THROTTLE_MS - 1)
    const lastSeen = dbB.prepare("SELECT last_seen_ms FROM social_presence WHERE viewer_id = 8001").get()
    assert.equal(lastSeen.last_seen_ms, t0, "节流窗口内的 touch 不得刷新 last_seen")
    presA.touch(8001, t0 + PRESENCE_THROTTLE_MS + 1)
    assert.equal(
        dbB.prepare("SELECT last_seen_ms FROM social_presence WHERE viewer_id = 8001").get().last_seen_ms,
        t0 + PRESENCE_THROTTLE_MS + 1,
        "节流窗口外的 touch 必须刷新 last_seen",
    )

    // 5min 窗口：以最后一次 touch 为基准，窗口内在线、超窗即离线
    const lastTouchAt = t0 + PRESENCE_THROTTLE_MS + 1
    assert.equal(presB.isOnline(8001, lastTouchAt + PRESENCE_WINDOW_MS - 1), true,
        "窗口内必须在线")
    assert.equal(presB.isOnline(8001, lastTouchAt + PRESENCE_WINDOW_MS + 1), false,
        "超过 5min 窗口必须判离线")

    // 惰性清扫：过期行在任意进程 touch 时被清掉
    dbA.prepare("INSERT INTO social_presence (viewer_id, last_seen_ms) VALUES (?, ?)")
        .run(8999, t0 - PRESENCE_WINDOW_MS - 1)
    presB.touch(8002, t0 + 2 * PRESENCE_WINDOW_MS)
    assert.equal(
        dbA.prepare("SELECT COUNT(*) AS n FROM social_presence WHERE viewer_id = 8999").get().n,
        0,
        "过期 presence 行必须被惰性清扫",
    )

    // ---- env 委托层：模块级函数走共享库 ----
    const viaDelegate = getOrCreateRecruitmentForRoom({
        hostPid: 9, hostViewerId: 7301, category: 1, questId: 1001001,
        roomNumber: "530001", isNewbieHost: false, establisherJson: "{}", nowMs: t0,
    })
    assert.equal(
        dbB.prepare("SELECT COUNT(*) AS n FROM attention_recruitments WHERE room_number = '530001'").get().n,
        1,
        "兼容层函数必须写入共享库（getAttentionStore 走 env 工厂）",
    )
    assert.ok(
        deliverOpenRecruitmentsToViewer(7302, t0 + 1, 3)
            .some(r => r.roomNumber === "530001"),
        "兼容层投递必须读到共享库行",
    )
    touchPresence(8101, t0)
    assert.equal(isPresenceOnline(8101, t0 + 1), true, "touchPresence 委托必须走共享表")
    assert.equal(
        dbB.prepare("SELECT COUNT(*) AS n FROM social_presence WHERE viewer_id = 8101").get().n,
        1,
    )
    // getAttentionStore 单例与显式构造的 store 指向同一存储语义
    assert.equal(getAttentionStore().findOpenRecruitmentByKey(viaDelegate.attentionKey, t0 + 2) !== null, true)
}

console.log("social store shared: all assertions passed")
