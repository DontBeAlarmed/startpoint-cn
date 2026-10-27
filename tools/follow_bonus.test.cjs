"use strict"

// 关注奖励（follow_bonus_info v4）回归：
// - 方向行内嵌计数：A→B 单向计数、单向显示；互关各自独立
// - 开战增量：StartBattle 配对 +10（单事务、每方向一行）
// - 取关清零：删行即清（无独立钩子）；重关注从 0 起
// - 上限双钳：计数与合计 1e6
// - 无关注边：字段省略（build 返回 null）

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => restoreContentSnapshot())

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "follow-bonus-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.DATA_DIR = databaseDirectory
process.once("exit", () => {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousSocialDbPath === undefined) delete process.env.MULTI_SOCIAL_DB_PATH
    else process.env.MULTI_SOCIAL_DB_PATH = previousSocialDbPath
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const {
    deleteSharedFollowEdgeSync,
    getCoopBonusCountsSync,
    incrementCoopBonusCountsSync,
    upsertSharedFollowEdgeSync,
} = require("../src/data/domains/social-follow")
const { buildFollowBonusInfo, incrementFollowBonusForBattle } = require("../src/lib/follow-bonus")

data.initializeDatabase()
const db = getDb()

const A = 61000101
const B = 61000102
const C = 61000103

function edge(follower, followed, count = 0) {
    upsertSharedFollowEdgeSync(follower, followed, 1_000_000)
    if (count > 0) {
        db.prepare("UPDATE social_follows SET coop_bonus_count = ? WHERE follower_viewer_id = ? AND followed_viewer_id = ?")
            .run(count, follower, followed)
    }
}

// ---- 无关注边：null（字段省略语义） ----
{
    assert.equal(buildFollowBonusInfo(A, [B, C]), null)
}

// ---- 单向：A→B（B 未回关）——A 看到计数，B 看不到 A ----
{
    edge(A, B)
    const forA = buildFollowBonusInfo(A, [B, C])
    assert.ok(forA !== null)
    assert.equal(forA.viewerId, A)
    assert.deepEqual(forA.followBonusList, { [String(B)]: 10 }, "首局预支 +10 → 10")
    assert.equal(forA.totalFollowBonus, 10)

    const forB = buildFollowBonusInfo(B, [A, C])
    assert.equal(forB, null, "B 未关注 A：B 视角无条目")

    // B 回关 → 互关：双方各自独立计数（都从 0 起，各显示 10）
    edge(B, A)
    const forB2 = buildFollowBonusInfo(B, [A])
    assert.deepEqual(forB2.followBonusList, { [String(A)]: 10 }, "互关后 B 视角独立计数 10")
}

// ---- 共斗增量：配对只覆盖已存在的方向行 ----
{
    // 成员 [A,B,C]：已存在边 A→B、B→A；C 无任何边
    // 增量前计数为 0（此前 assert 只做了显示预支，未入库）→ 首局后计数 = 10
    incrementFollowBonusForBattle([A, B, C])
    assert.equal(getCoopBonusCountsSync(A, [B])[B], 10, "A→B 计数首局 +10")
    assert.equal(getCoopBonusCountsSync(B, [A])[A], 10, "B→A 计数独立首局 +10")
    assert.equal(getCoopBonusCountsSync(A, [C])[C] ?? 0, 0, "无边不记账")
    assert.equal(getCoopBonusCountsSync(C, [A])[A] ?? 0, 0)

    // 第二局预支：计数 10 + 预支 10 = 显示 20（即第 2 把）
    const forA = buildFollowBonusInfo(A, [B])
    assert.equal(forA.followBonusList[String(B)], 20, "一局已计 + 本局预支 = 20")
    assert.equal(forA.totalFollowBonus, 20)

    // 第二局开战：计数 20 → 第三局预支 30（第 3 把）
    incrementFollowBonusForBattle([A, B, C])
    const forA2 = buildFollowBonusInfo(A, [B])
    assert.equal(forA2.followBonusList[String(B)], 30, "两局已计 + 本局预支 = 30")
}

// ---- 取关清零：删行即清；重关注从 0 起 ----
{
    deleteSharedFollowEdgeSync(A, B)
    assert.equal(getCoopBonusCountsSync(A, [B])[B] ?? 0, 0, "取关后计数清零")
    assert.equal(buildFollowBonusInfo(A, [B]), null, "取关后无条目")

    edge(A, B)
    assert.equal(getCoopBonusCountsSync(A, [B])[B], 0, "重关注新行从 0 起")
    const forA = buildFollowBonusInfo(A, [B])
    assert.equal(forA.followBonusList[String(B)], 10, "重关注首局预支 10")
}

// ---- 上限双钳：计数 1e6 → 增量封顶；显示值与合计各自钳 1e6 ----
{
    edge(A, B, 1_000_000)
    incrementFollowBonusForBattle([A, B])
    assert.equal(getCoopBonusCountsSync(A, [B])[B], 1_000_000, "计数钳 1e6")
    const forA = buildFollowBonusInfo(A, [B])
    assert.equal(forA.followBonusList[String(B)], 1_000_000, "显示值钳 1e6")
}

// ---- 双队友聚合 + 自边保护 ----
{
    db.prepare("DELETE FROM social_follows").run()
    edge(A, B)
    edge(A, C)
    const forA = buildFollowBonusInfo(A, [B, C])
    assert.deepEqual(forA.followBonusList, { [String(B)]: 10, [String(C)]: 10 })
    assert.equal(forA.totalFollowBonus, 20, "合计 = Σ逐人")

    // 自我配对被 increment 跳过（无 A→A 行，亦不抛错）
    assert.doesNotThrow(() => incrementFollowBonusForBattle([A]))
}

// ---- 败局/放弃局时序瑕疵（已接受残留）：仅显示层，计数以 StartBattle 为准 ----
{
    // StartBattle 前放弃：计数未增，但本局 start 已预支——下一局显示回正确值
    const before = buildFollowBonusInfo(A, [B]).followBonusList[String(B)]
    assert.equal(before, 10, "未开战：仅预支 10")
}

console.log("follow bonus: all assertions passed")
