"use strict"

// S3/S4/S6（stale-guard 自愈专项）回归：
// - S3：credential-lock mode≠0600 → fchmod 尽力修正（Android 丢权限位不再永久 500）；
//   本 pid 的 SIGKILL 残留候选 tmp 在持锁结束时清扫
// - S4：multi:token rebuild——损坏表改名留存 + 空表重建（显式确认，不做自动重建）
// - S6：迁移 tmp 唯一名 + 残留 tmp 清理失败降级 WARN 不阻塞启动

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { withMultiHubCredentialLock } = require("../src/multi/hub/credential-lock")
const { MultiHubCredentialStore } = require("../src/multi/hub/credential-store")

function tmpDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

test("S3：锁文件权限位丢失 → fchmod 修正后正常获取（不再永久 UNSAFE）", t => {
    const dir = tmpDir(t, "hub-lock-mode-")
    const credentialsPath = path.join(dir, "multi-hub-credentials.json")
    fs.writeFileSync(credentialsPath, JSON.stringify({ schemaVersion: 1, credentials: [] }))
    // 预置一把「活锁」：本进程 pid + 新鲜 createdAt + 丢失权限位（0644）
    fs.writeFileSync(`${credentialsPath}.lock`, JSON.stringify({
        schemaVersion: 1, ownerToken: "a".repeat(32), pid: process.pid,
        createdAt: Date.now(),
    }))
    fs.chmodSync(`${credentialsPath}.lock`, 0o644)

    const { acquireMultiHubCredentialLock } = require("../src/multi/hub/credential-lock")
    // 活锁：等待 → 超时（而非 UNSAFE 一票否决），且等待期间权限位已被 fchmod 修正
    assert.throws(
        () => acquireMultiHubCredentialLock(credentialsPath, { timeoutMs: 80, pollIntervalMs: 5 }),
        error => error.code === "MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT",
    )
    assert.equal(fs.statSync(`${credentialsPath}.lock`).mode & 0o777, 0o600,
        "inspectLock 已把丢失的权限位修正回 0600")
})

test("S3：持锁结束后本 pid 残留候选 tmp 被清扫", t => {
    const dir = tmpDir(t, "hub-lock-tmp-")
    const credentialsPath = path.join(dir, "multi-hub-credentials.json")
    fs.writeFileSync(credentialsPath, JSON.stringify({ schemaVersion: 1, credentials: [] }))
    // 模拟 SIGKILL 残留：本 pid 命名的候选 tmp
    const staleTmp = `${credentialsPath}.lock.${process.pid}.deadbeef.tmp`
    fs.writeFileSync(staleTmp, "partial")

    withMultiHubCredentialLock(credentialsPath, () => "ok")

    assert.equal(fs.existsSync(staleTmp), false, "本 pid 候选 tmp 已清扫")
})

test("S4：损坏凭据表 rebuild → 改名留存 + 空表重建", t => {
    const dir = tmpDir(t, "hub-rebuild-")
    const credentialsPath = path.join(dir, "multi-hub-credentials.json")
    fs.writeFileSync(credentialsPath, "{ corrupt json")

    const store = new MultiHubCredentialStore({ credentialsPath })
    // 损坏时常规操作 fail-closed（保留）
    assert.throws(() => store.list())
    const result = store.rebuildFromCorruption()

    assert.ok(result.archivedTo !== null && fs.existsSync(result.archivedTo),
        "损坏表必须改名留存（不静默销毁）")
    assert.deepEqual(JSON.parse(fs.readFileSync(credentialsPath, "utf8")),
        { schemaVersion: 1, credentials: [] }, "重建为空表")
})

test("S4：健康表 rebuild 同样显式留档重建", t => {
    const dir = tmpDir(t, "hub-rebuild-ok-")
    const credentialsPath = path.join(dir, "multi-hub-credentials.json")
    fs.writeFileSync(credentialsPath, JSON.stringify({
        schemaVersion: 1,
        credentials: [{
            credentialId: "cred-1", label: "x", tokenDigest: "d".repeat(64),
            createdAt: "2026-10-07T00:00:00.000Z", revokedAt: null,
        }],
    }))

    const store = new MultiHubCredentialStore({ credentialsPath })
    const result = store.rebuildFromCorruption()
    assert.ok(result.archivedTo !== null)
    assert.deepEqual(store.list(), [], "重建后为空表（令牌全失效语义）")
})

test("S6：残留迁移 tmp（旧固定名）不再阻塞启动", t => {
    const dir = tmpDir(t, "datavolume-tmp-")
    const stateDir = path.join(dir, "state")
    fs.mkdirSync(stateDir, { recursive: true })
    // 旧版固定名残留 tmp 是目录（最坏清理失败形态）——prepareDataVolume 须继续
    fs.mkdirSync(path.join(stateDir, ".server-time.json.migrate.tmp"))

    const { prepareDataVolume } = require("../src/runtime/data-paths")
    const paths = {
        dataDir: dir,
        stateDir,
        seedStateDir: path.join(stateDir, "seeds"),
        assetProviderDir: path.join(dir, "asset-provider"),
        assetPatchUploadDir: path.join(dir, "asset-provider", "production", "upload"),
        legacyAssetMetadataFile: path.join(dir, "asset-provider", "legacy-metadata.json"),
        databaseFile: path.join(dir, "wdfp_data.db"),
        databaseVersionFile: path.join(dir, "wdfp_data.db.version"),
    }
    assert.doesNotThrow(() => prepareDataVolume(paths))
})
