"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const childScript = String.raw`
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")

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
            throw new Error("unexpected CDN probe during import: " + method + " " + filePath)
        }
        return originals[method](filePath, ...args)
    }
}

const assetModule = require("./src/routes/cn/asset")
assert.deepEqual(probes, [])

const {
    productionContentSnapshotProvider,
} = require("./src/content/runtime/content-snapshot")
const archive = {
    relativePath: "archive-common-full/pinball-1.4.0-1-abcd.zip",
    compressedBytes: 12,
    sha256: "a".repeat(64),
    layer: "common",
    order: 1,
}
const secondArchive = {
    ...archive,
    relativePath: "archive-android-full/pinball-1.4.0-1-abcd.zip",
    compressedBytes: 8,
}
const edges = ["shortened", "fulfill"].map(assetSizeKind => ({
    fromVersion: null,
    toVersion: "1.4.0",
    platform: "android",
    assetSizeKind,
    archives: [archive, secondArchive],
}))
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

assert.deepEqual(assetModule.getCdnVersionInfo("https://cdn.test/patch/cn"), {
    base_url: "https://cdn.test/patch/cn/",
    files_list: "https://cdn.test/patch/cn/recovery/empty.csv",
    total_size: 30,
    delayed_assets_size: 0,
})
assert.deepEqual(probes, [])
process.stdout.write("ASSET_IMPORT_OK\n")
`

test("importing the CN asset dependency chain performs no CDN filesystem probes", () => {
    const result = spawnSync(
        process.execPath,
        ["-r", "ts-node/register/transpile-only", "-e", childScript],
        {
            cwd: path.join(__dirname, ".."),
            encoding: "utf8",
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
        },
    )

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /ASSET_IMPORT_OK/)
})
