"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const {
    ContentSnapshotProvider,
    ConfiguredContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

let seq = 0
function makeSnapshot(targetVersion) {
    seq += 1
    const mark = { id: seq }
    // repository.info() 被 admin/内容状态消费；最小形状即可
    return {
        cdn: { targetVersion, edges: [], archiveSources: { schemaVersion: 1, archives: [] } },
        repository: { info: () => ({ multiBattleContentDigest: `digest-${targetVersion}` }), table: () => [] },
        __mark: mark,
    }
}

test("裸 Provider：reload 从 snapshotSource 取新快照并原子替换", async () => {
    const snapshots = [makeSnapshot("1.0.0"), makeSnapshot("1.0.1")]
    let calls = 0
    const provider = new ContentSnapshotProvider({
        snapshotSource: { load: async () => snapshots[calls++] },
    })
    await provider.initialize()
    assert.equal(provider.get(), snapshots[0])

    const { previous, current } = await provider.reload()
    assert.equal(previous, snapshots[0])
    assert.equal(current, snapshots[1])
    assert.equal(provider.get(), snapshots[1])
})

test("裸 Provider：load 返回同一实例时 reload 抛 NOOP（提示路径被记忆化）", async () => {
    const fixed = makeSnapshot("2.0.0")
    const provider = new ContentSnapshotProvider({
        snapshotSource: { load: async () => fixed },
    })
    await provider.initialize()
    await assert.rejects(() => provider.reload(), /RELOAD_NOOP/)
    assert.equal(provider.get(), fixed)
})

test("Configured 层级（双审 P0 回归）：reload 绕过 inner provider 记忆化，真正换内容", async () => {
    // 生产单例是 ConfiguredContentSnapshotProvider：其 snapshotSource.load()
    // 内部缓存 inner provider——reload 若走基类路径会拿回旧快照（假成功）。
    const snapshots = [makeSnapshot("3.0.0"), makeSnapshot("3.0.1")]
    let created = 0
    const provider = new ConfiguredContentSnapshotProvider({
        createProvider: () => {
            const snapshot = snapshots[Math.min(created++, snapshots.length - 1)]
            return new ContentSnapshotProvider({
                snapshotSource: { load: async () => snapshot },
            })
        },
    })
    await provider.initialize({})
    assert.equal(provider.get(), snapshots[0])

    const { previous, current } = await provider.reload()
    assert.equal(previous, snapshots[0], "previous 必须是启动快照")
    assert.equal(current, snapshots[1], "current 必须是新读盘的快照（P0：走基类路径会恒等于 previous）")
    assert.equal(provider.get(), snapshots[1])
})

test("并发语义：reload×reload 共享同一 in-flight；initialize 在飞时 reload 等待落地", async () => {
    const snapshots = [makeSnapshot("4.0.0"), makeSnapshot("4.0.1"), makeSnapshot("4.0.2")]
    let created = 0
    let releaseSecond = null
    const gate = new Promise(resolve => { releaseSecond = resolve })
    const provider = new ConfiguredContentSnapshotProvider({
        createProvider: () => {
            const snapshot = snapshots[Math.min(created++, snapshots.length - 1)]
            return new ContentSnapshotProvider({
                snapshotSource: {
                    load: created === 2
                        ? () => gate.then(() => snapshot)
                        : async () => snapshot,
                },
            })
        },
    })
    await provider.initialize({})

    const first = provider.reload()
    const second = provider.reload()
    // 共享同一 in-flight 的可观测语义：并发调用者拿到相同结果，且底层
    // 只新建一次 provider（initialize 1 次 + reload 1 次 = created 2）
    releaseSecond?.()
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult.current, snapshots[1])
    assert.equal(secondResult.current, snapshots[1])
    assert.equal(created, 2, "并发 reload 不得重复构造 inner provider")
})

test("validate 钩子：候选快照校验抛错时保持旧快照继续服务（R-04 预检）", async () => {
    const snapshots = [makeSnapshot("5.0.0"), makeSnapshot("5.0.1")]
    let calls = 0
    const provider = new ContentSnapshotProvider({
        snapshotSource: { load: async () => snapshots[Math.min(calls++, snapshots.length - 1)] },
    })
    await provider.initialize()
    await assert.rejects(
        () => provider.reload({
            validate: candidate => {
                throw new Error(`Gacha 142 period is reversed. (candidate=${candidate.cdn.targetVersion})`)
            },
        }),
        /period is reversed/,
    )
    assert.equal(provider.get(), snapshots[0], "校验失败必须保持旧快照对外服务")

    const swapped = await provider.reload({ validate: () => {} })
    assert.equal(swapped.current, snapshots[1], "校验通过必须正常换快照")
    assert.equal(provider.get(), snapshots[1])
})

test("validate 钩子：Configured 层同样在替换前校验（双审 P0 路径不被绕过）", async () => {
    const snapshots = [makeSnapshot("6.0.0"), makeSnapshot("6.0.1")]
    let created = 0
    const provider = new ConfiguredContentSnapshotProvider({
        createProvider: () => {
            const snapshot = snapshots[Math.min(created++, snapshots.length - 1)]
            return new ContentSnapshotProvider({
                snapshotSource: { load: async () => snapshot },
            })
        },
    })
    await provider.initialize({})
    await assert.rejects(
        () => provider.reload({ validate: () => { throw new Error("smoke failed") } }),
        /smoke failed/,
    )
    assert.equal(provider.get(), snapshots[0], "Configured 层校验失败同样保持旧快照")

    const swapped = await provider.reload({ validate: () => {} })
    assert.equal(swapped.current, snapshots[1])
})
