"use strict"

// S1/S2（stale-guard 自愈专项）：sync.lock pid 检活 + stale 接管、空锁/垃圾锁超时接管。
// 误判方向论证（任务书 §二 S1，写进测试注释）：pid 被复用为无关进程时 ESRCH 不出现
// → 不接管，不会误删活锁；接管失败回落既有超时语义。symlink/非普通文件保持 fail-closed。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    acquireContentSyncLock,
    ContentSyncLockError,
} = require("../src/content/sync/lock")

function createSandbox(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const contentStateDir = path.join(dir, "state", "content")
    fs.mkdirSync(contentStateDir, { recursive: true })
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return { contentStateDir }
}

const DEAD_PID = 999_999_999

function agedLock(contentStateDir, { pid = DEAD_PID, ageMs }) {
    const lockPath = path.join(contentStateDir, "sync.lock")
    fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, token: "a".repeat(32), pid }))
    const past = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, past, past)
    return lockPath
}

test("S1：死 pid + 锁龄超阈值 → 接管成功", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-dead-")
    agedLock(contentStateDir, { ageMs: 120_000 })
    const lock = await acquireContentSyncLock(contentStateDir, {
        timeoutMs: 300, pollIntervalMs: 5, staleThresholdMs: 60_000,
    })
    assert.equal(fs.readFileSync(lock.lockPath, "utf8").includes(String(DEAD_PID)), false,
        "旧锁已被替换为本次持有者的锁")
    await lock.release()
    assert.equal(fs.existsSync(path.join(contentStateDir, "sync.lock")), false)
})

test("S1：死 pid + 锁龄未超阈值 → 继续等待至阈值后接管（总窗口 = timeout + stale）", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-fresh-")
    agedLock(contentStateDir, { ageMs: 0 }) // 新鲜死 pid 锁：阈值门先于 timeout 满足
    // 收口语义（双审修 3）：timeoutMs 后不抛，继续睡到锁龄 ≥ staleThresholdMs 再接管
    const lock = await acquireContentSyncLock(contentStateDir, {
        timeoutMs: 80, pollIntervalMs: 5, staleThresholdMs: 150,
    })
    assert.equal(fs.readFileSync(lock.lockPath, "utf8").includes(String(DEAD_PID)), false)
    await lock.release()
})

test("S1：活 pid 锁即使超龄也不接管 → 总窗口超时（TIMEOUT）", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-alive-window-")
    agedLock(contentStateDir, { pid: process.pid, ageMs: 120_000 })
    await assert.rejects(
        acquireContentSyncLock(contentStateDir, {
            timeoutMs: 60, pollIntervalMs: 5, staleThresholdMs: 60_000,
            isProcessAlive: () => true,
        }),
        error => error instanceof ContentSyncLockError
            && error.code === "CONTENT_SYNC_LOCK_TIMEOUT"
            && new RegExp(String(process.pid)).test(error.message),
    )
    assert.equal(fs.readFileSync(path.join(contentStateDir, "sync.lock"), "utf8")
        .includes(String(process.pid)), true, "活锁不被误删")
})

test("S1：pid 存活（注入恒活）→ 不接管，超时失败", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-alive-")
    agedLock(contentStateDir, { pid: process.pid, ageMs: 120_000 })
    await assert.rejects(
        acquireContentSyncLock(contentStateDir, {
            timeoutMs: 60, pollIntervalMs: 5, staleThresholdMs: 60_000,
            isProcessAlive: () => true, // 模拟 pid 复用为无关进程：ESRCH 不出现 → 不接管
        }),
        error => error instanceof ContentSyncLockError && error.code === "CONTENT_SYNC_LOCK_TIMEOUT",
    )
    assert.equal(fs.readFileSync(path.join(contentStateDir, "sync.lock"), "utf8").includes(String(process.pid)), true,
        "活锁不被误删")
})

test("S2：空锁文件（SIGKILL 落在 open 与 write 之间）→ 超时后接管", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-empty-")
    fs.writeFileSync(path.join(contentStateDir, "sync.lock"), "")
    const lock = await acquireContentSyncLock(contentStateDir, {
        timeoutMs: 60, pollIntervalMs: 5, staleThresholdMs: 60_000,
    })
    await lock.release()
})

test("S2：垃圾内容锁 → 超时后接管", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-garbage-")
    fs.writeFileSync(path.join(contentStateDir, "sync.lock"), "old lock")
    const lock = await acquireContentSyncLock(contentStateDir, {
        timeoutMs: 60, pollIntervalMs: 5, staleThresholdMs: 60_000,
    })
    await lock.release()
})

test("S2：symlink 锁保持 fail-closed（UNSAFE，不接管）", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-symlink-")
    const target = path.join(contentStateDir, "elsewhere.lock")
    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, token: "a".repeat(32), pid: DEAD_PID }))
    fs.symlinkSync(target, path.join(contentStateDir, "sync.lock"))
    await assert.rejects(
        acquireContentSyncLock(contentStateDir, { timeoutMs: 60, pollIntervalMs: 5 }),
        error => error instanceof ContentSyncLockError && error.code === "CONTENT_SYNC_LOCK_UNSAFE",
    )
})

test("S2：非普通文件（目录）保持 fail-closed（LEGACY，不接管）", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-dir-")
    fs.mkdirSync(path.join(contentStateDir, "sync.lock"))
    await assert.rejects(
        acquireContentSyncLock(contentStateDir, { timeoutMs: 60, pollIntervalMs: 5 }),
        error => error instanceof ContentSyncLockError && error.code === "CONTENT_SYNC_LOCK_LEGACY",
    )
})

test("S1+S2：接管后原等待者正常获得锁并 release；接管失败回落超时语义", async t => {
    const { contentStateDir } = createSandbox(t, "lock-stale-chain-")
    // 接管目标：identity 会变化的场景无法稳定构造——验证接管成功链路即可
    agedLock(contentStateDir, { ageMs: 120_000 })
    const lock = await acquireContentSyncLock(contentStateDir, {
        timeoutMs: 300, pollIntervalMs: 5, staleThresholdMs: 60_000,
    })
    // 第二个等待者：现在锁是活的（本测试进程持有）→ 超时失败（回落语义）
    await assert.rejects(
        acquireContentSyncLock(contentStateDir, {
            timeoutMs: 60, pollIntervalMs: 5, staleThresholdMs: 60_000,
            isProcessAlive: () => true,
        }),
        error => error instanceof ContentSyncLockError && error.code === "CONTENT_SYNC_LOCK_TIMEOUT",
    )
    await lock.release()
})
