"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { buildAdminContentStatus } = require("../src/lib/admin-content-status")

function archive(relativePath, compressedBytes) {
    return { relativePath, compressedBytes, sha256: "a".repeat(64), layer: "common", order: 1 }
}

function snapshotWithPatches() {
    const baselineArchive = archive("archive-common-diff/pinball-1.4.0-1.4.54-1-a.zip", 100)
    const patch55 = archive("archive-common-diff/pinball-1.4.54-1.4.55-1-b.zip", 20)
    const patch56 = archive("archive-common-diff/pinball-1.4.55-1.4.56-1-c.zip", 30)
    return {
        cdn: {
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.56",
            installedBytes: 150,
            entityListsRelativePath: "EntityLists/cn.csv",
            edges: [
                { fromVersion: "1.4.0", toVersion: "1.4.54", platform: "android", assetSizeKind: "shortened", archives: [baselineArchive] },
                { fromVersion: "1.4.0", toVersion: "1.4.54", platform: "android", assetSizeKind: "fulfill", archives: [baselineArchive] },
                { fromVersion: "1.4.54", toVersion: "1.4.55", platform: "android", assetSizeKind: "shortened", archives: [patch55] },
                { fromVersion: "1.4.54", toVersion: "1.4.55", platform: "android", assetSizeKind: "fulfill", archives: [patch55] },
                { fromVersion: "1.4.55", toVersion: "1.4.56", platform: "android", assetSizeKind: "shortened", archives: [patch56] },
                { fromVersion: "1.4.55", toVersion: "1.4.56", platform: "android", assetSizeKind: "fulfill", archives: [patch56] },
            ],
        },
        archiveSources: {
            schemaVersion: 1,
            archives: [
                { relativePath: baselineArchive.relativePath, source: { kind: "baseline" } },
                { relativePath: patch55.relativePath, source: { kind: "patch", targetVersion: "1.4.55" } },
                { relativePath: patch56.relativePath, source: { kind: "patch", targetVersion: "1.4.56" } },
            ],
        },
        repository: {
            info: () => ({
                source: "release",
                assetVersion: "1.4.56",
                generatorVersion: 3,
                releaseDigest: `sha256:${"d".repeat(64)}`,
                contentDigest: `sha256:${"e".repeat(64)}`,
                multiBattleContentDigest: `sha256:${"f".repeat(64)}`,
            }),
        },
    }
}

test("builds active overlay status from the pinned content snapshot", () => {
    const result = buildAdminContentStatus({
        snapshot: snapshotWithPatches(),
        assetProvider: {
            mode: "local",
            baseUrl: "http://127.0.0.1:8001/patch/cn",
            cdnRoot: "/private/cdn/cn",
            patchUploadRoot: "/private/data/upload",
        },
        configuredCdnDir: "/private/cdn",
    })

    assert.equal(result.baseUrl, "http://127.0.0.1:8001/patch/cn")
    assert.deepEqual(result.baseline, {
        mode: "official-cn-overlay",
        source: "国服最终 CDN",
        fullVersion: "1.4.0",
        cnFinalVersion: "1.4.54",
        detectedArchiveVersion: "1.4.56",
        manifestVersion: "1.4.56",
        pinned: true,
        dataScope: ["items", "characters", "events", "quests", "shops"],
    })
    assert.deepEqual(result.extension, {
        mode: "manifest-overlay",
        status: "active",
        runtimeEnabled: true,
        effectiveVersionPreview: "1.4.56",
        enabledPatchCount: 2,
        totalPatchCount: 2,
        activePatchArchiveCount: 2,
        versions: ["1.4.55", "1.4.56"],
        note: "补丁已进入当前固定 Content Snapshot。",
    })
    assert.deepEqual(result.storage, {
        mode: "local",
        configuredDir: "/private/cdn",
        directoryPresent: true,
        archiveCount: 3,
        archiveBytes: 150,
        latestArchiveMtime: null,
    })
    assert.deepEqual(result.contentRelease, {
        source: "release",
        assetVersion: "1.4.56",
        generatorVersion: 3,
        releaseDigest: `sha256:${"d".repeat(64)}`,
        contentDigest: `sha256:${"e".repeat(64)}`,
        multiBattleContentDigest: `sha256:${"f".repeat(64)}`,
    })
})

test("reports an empty overlay without inventing patch state", () => {
    const snapshot = snapshotWithPatches()
    snapshot.cdn.targetVersion = "1.4.54"
    snapshot.cdn.edges = snapshot.cdn.edges.slice(0, 2)
    snapshot.archiveSources.archives = snapshot.archiveSources.archives.slice(0, 1)
    snapshot.repository.info = () => ({
        source: "bundled",
        assetVersion: "1.4.54",
        generatorVersion: 3,
        releaseDigest: null,
        contentDigest: `sha256:${"1".repeat(64)}`,
        multiBattleContentDigest: `sha256:${"2".repeat(64)}`,
    })

    const result = buildAdminContentStatus({
        snapshot,
        assetProvider: { mode: "client-owned" },
        configuredCdnDir: ".cdn",
    })

    assert.equal(result.baseUrl, null)
    assert.equal(result.extension.status, "empty")
    assert.equal(result.extension.runtimeEnabled, false)
    assert.equal(result.extension.enabledPatchCount, 0)
    assert.deepEqual(result.extension.versions, [])
    assert.equal(result.storage.mode, "client-owned")
    assert.equal(result.storage.directoryPresent, false)
    assert.equal(result.storage.archiveCount, 1)
    assert.equal(result.contentRelease.source, "bundled")
    assert.equal(result.contentRelease.contentDigest, `sha256:${"1".repeat(64)}`)
    assert.equal(result.contentRelease.multiBattleContentDigest, `sha256:${"2".repeat(64)}`)
})
