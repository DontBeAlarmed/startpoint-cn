"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { ContentSnapshotError } = require("../src/content/runtime/content-snapshot")

const RELEASE_DIGEST = `sha256:${"7".repeat(64)}`
const compatibility = Object.freeze({
    multiProtocolVersion: 1,
    APP_VER: "1.8.1",
    RES_VER: "1.4.54",
    cdnTargetVersion: "1.4.54",
    contentDigest: RELEASE_DIGEST,
    modeDigest: `sha256:${"8".repeat(64)}`,
})

function snapshot() {
    return {
        cdn: { targetVersion: "1.4.54" },
        repository: {
            info: () => ({
                source: "release",
                assetVersion: "1.4.54",
                generatorVersion: 3,
                releaseDigest: RELEASE_DIGEST,
                contentDigest: RELEASE_DIGEST,
                multiBattleContentDigest: RELEASE_DIGEST,
            }),
            table: () => undefined,
        },
    }
}

test("embedded context construction defers compatibility source and recovers after initialization", () => {
    let initialized = false
    let snapshotCalls = 0
    let modeCalls = 0
    const context = createEmbeddedMultiHttpContext({
        compatibilityProfileDependencies: {
            getContentSnapshot: () => {
                snapshotCalls++
                if (!initialized) {
                    throw new ContentSnapshotError(
                        "CONTENT_SNAPSHOT_NOT_INITIALIZED",
                        "embedded context test",
                    )
                }
                return snapshot()
            },
            getLoadedModeIdentities: () => {
                modeCalls++
                return []
            },
        },
    })

    assert.equal(snapshotCalls, 0)
    assert.equal(modeCalls, 0)
    assert.deepEqual(
        context.snapshotProvider.getCompatibility({ APP_VER: "1.8.1", RES_VER: "1.4.54" }),
        { ok: false, error: "INCOMPATIBLE_ROOM" },
    )

    initialized = true
    const recovered = context.snapshotProvider.getCompatibility({
        APP_VER: "1.8.1",
        RES_VER: "1.4.54",
    })
    const cached = context.snapshotProvider.getCompatibility({
        APP_VER: "custom",
        RES_VER: "custom-resource",
    })

    assert.equal(recovered.ok, true)
    assert.equal(cached.ok, true)
    assert.equal(recovered.value.contentDigest, RELEASE_DIGEST)
    // 2 → 3：profile 源按请求解析快照（c602d1aa 双审契约，实例比对缓存）——
    // 每次兼容性判定都经 getter 取当前快照，含缓存命中的 custom 版本判定
    assert.equal(snapshotCalls, 3)
    assert.equal(modeCalls, 2)
})

test("fixed embedded compatibility never reads profile dependencies", () => {
    let dependencyCalls = 0
    const context = createEmbeddedMultiHttpContext({
        compatibility,
        compatibilityProfileDependencies: {
            getContentSnapshot: () => {
                dependencyCalls++
                throw new Error("fixed compatibility must not read snapshot")
            },
            getLoadedModeIdentities: () => {
                dependencyCalls++
                throw new Error("fixed compatibility must not read modes")
            },
        },
    })

    assert.deepEqual(context.snapshotProvider.getCompatibility({}), {
        ok: true,
        value: compatibility,
    })
    assert.equal(dependencyCalls, 0)
})
