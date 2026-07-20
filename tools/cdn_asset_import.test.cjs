"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

test("importing the CN asset plugin performs no CDN filesystem probes", () => {
    const assetModulePath = require.resolve("../src/routes/cn/asset")
    delete require.cache[assetModulePath]

    const probes = []
    const originals = {
        existsSync: fs.existsSync,
        readdirSync: fs.readdirSync,
        statSync: fs.statSync,
    }
    const isCdnPath = value => /(?:^|[\\/])(?:\.cdn|archive-[^\\/]+|EntityLists|entities)(?:[\\/]|$)/i
        .test(String(value))

    for (const method of Object.keys(originals)) {
        fs[method] = (filePath, ...args) => {
            if (isCdnPath(filePath)) {
                probes.push({ method, filePath: String(filePath) })
                throw new Error(`unexpected CDN probe during import: ${method} ${filePath}`)
            }
            return originals[method](filePath, ...args)
        }
    }

    try {
        let assetModule
        assert.doesNotThrow(() => { assetModule = require(assetModulePath) })
        assert.deepEqual(probes, [])

        const archive = {
            relativePath: "archive-common-full/pinball-1.4.0-1-abcd.zip",
            compressedBytes: 12,
            sha256: "a".repeat(64),
            layer: "common",
            order: 1,
        }
        const secondArchive = { ...archive, relativePath: "archive-android-full/pinball-1.4.0-1-abcd.zip", compressedBytes: 8 }
        const edges = ["shortened", "fulfill"].map(assetSizeKind => ({
            fromVersion: null,
            toVersion: "1.4.0",
            platform: "android",
            assetSizeKind,
            archives: [archive, secondArchive],
        }))
        const previousSnapshot = productionContentSnapshotProvider.snapshot
        productionContentSnapshotProvider.snapshot = Object.freeze({
            cdn: Object.freeze({
                schemaVersion: 1,
                fullBaseVersion: "1.4.0",
                targetVersion: "1.4.1",
                installedBytes: 30,
                entityListsRelativePath: "EntityLists/10939-android_medium.csv",
                edges,
            }),
        })
        try {
            assert.deepEqual(assetModule.getCdnVersionInfo("https://cdn.test/patch/cn"), {
                base_url: "https://cdn.test/patch/cn/EntityLists/",
                files_list: "https://cdn.test/patch/cn/EntityLists/10939-android_medium.csv",
                total_size: 20,
                delayed_assets_size: 0,
            })
            assert.deepEqual(probes, [])
        } finally {
            productionContentSnapshotProvider.snapshot = previousSnapshot
        }
    } finally {
        Object.assign(fs, originals)
        delete require.cache[assetModulePath]
    }
})
