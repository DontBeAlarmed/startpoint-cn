"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createCdnRuntimeManifest,
    parseCdnRuntimeManifest,
    serializeCdnRuntimeManifest,
} = require("../src/content/cdn/runtime-manifest")
const { buildCdnCatalog } = require("../src/content/cdn/catalog-builder")
const {
    executeManifestCli,
    ManifestCliError,
    parseArguments,
    run,
} = require("./generate_cdn_runtime_manifest.cjs")

const DIGEST_A = "a".repeat(64)

function archive(overrides = {}) {
    const kind = overrides.kind ?? "diff"
    const layer = overrides.layer ?? "common"
    const order = overrides.order ?? 1
    const fromVersion = kind === "full" ? null : (overrides.fromVersion ?? "1.4.53")
    const toVersion = overrides.toVersion ?? (kind === "full" ? "1.4.53" : "1.4.54")
    const directoryLayer = layer === "quality" ? "medium" : layer === "platform" ? "android" : "common"
    const fileName = kind === "full"
        ? `pinball-${toVersion}-${order}-abcd.zip`
        : `pinball-${fromVersion}-${toVersion}-${order}-abcd.zip`

    return {
        kind,
        fromVersion,
        toVersion,
        platform: "android",
        layer,
        order,
        relativePath: `archive-${directoryLayer}-${kind}/${fileName}`,
        compressedBytes: 10 + order,
        sha256: DIGEST_A,
        ...overrides,
    }
}

function validInput() {
    return {
        archives: [
            archive({ layer: "platform" }),
            archive({ kind: "full", layer: "quality" }),
            archive({ layer: "common" }),
            archive({ kind: "full", layer: "platform" }),
            archive({ layer: "quality" }),
            archive({ kind: "full", layer: "common" }),
        ],
        installedBytes: 123,
        entityListsRelativePath: "EntityLists/fixture-android_medium.csv",
    }
}

function validEntityLists(input = validInput()) {
    return {
        relativePath: input.entityListsRelativePath,
        compressedBytes: 42,
        sha256: DIGEST_A,
    }
}

function validManifest() {
    const input = validInput()
    return createCdnRuntimeManifest(input, validEntityLists(input))
}

test("creates a deterministic cn-1.4.54 manifest in Catalog order", () => {
    const input = validInput()
    const manifest = createCdnRuntimeManifest(input, validEntityLists(input))

    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.baseline, "cn-1.4.54")
    assert.deepEqual(manifest.catalogInput.archives.map(item => [item.kind, item.layer]), [
        ["full", "common"],
        ["full", "quality"],
        ["full", "platform"],
        ["diff", "common"],
        ["diff", "quality"],
        ["diff", "platform"],
    ])

    const serialized = serializeCdnRuntimeManifest(manifest)
    assert.equal(serialized, serializeCdnRuntimeManifest(manifest))
    assert.ok(serialized.endsWith("\n"))
    assert.deepEqual(parseCdnRuntimeManifest(JSON.parse(serialized)), manifest)
})

test("strictly rejects malformed runtime manifests", () => {
    const base = JSON.parse(serializeCdnRuntimeManifest(validManifest()))
    const invalidValues = [
        { ...base, schemaVersion: 2 },
        { ...base, baseline: "cn-1.4.53" },
        { ...base, unexpected: true },
        { ...base, catalogInput: { ...base.catalogInput, unexpected: true } },
        {
            ...base,
            catalogInput: {
                ...base.catalogInput,
                archives: base.catalogInput.archives.map((item, index) => (
                    index === 0 ? { ...item, unexpected: true } : item
                )),
            },
        },
        { ...base, entityLists: { ...base.entityLists, unexpected: true } },
        {
            ...base,
            catalogInput: {
                ...base.catalogInput,
                archives: base.catalogInput.archives.map((item, index) => (
                    index === 0 ? { ...item, relativePath: "/tmp/archive.zip" } : item
                )),
            },
        },
        { ...base, entityLists: { ...base.entityLists, relativePath: "../EntityLists/list.csv" } },
        { ...base, entityLists: { ...base.entityLists, sha256: "A".repeat(64) } },
        { ...base, entityLists: { ...base.entityLists, compressedBytes: Number.MAX_SAFE_INTEGER + 1 } },
        { ...base, catalogInput: { ...base.catalogInput, installedBytes: Number.MAX_SAFE_INTEGER + 1 } },
        { ...base, entityLists: { ...base.entityLists, relativePath: "EntityLists/other.csv" } },
        {
            ...base,
            catalogInput: {
                ...base.catalogInput,
                archives: base.catalogInput.archives.filter(item => item.kind === "full"),
            },
        },
    ]

    for (const value of invalidValues) {
        assert.throws(() => parseCdnRuntimeManifest(value))
    }
})

test("manifest CLI accepts only explicit output and audit path overrides", () => {
    assert.deepEqual(parseArguments([]), {
        outputPath: null,
        pathOverrides: {},
    })
    assert.deepEqual(parseArguments([
        "--output", "assets/cdn/manifest.json",
        "--cdn-dir", "/srv/cdn",
        "--content-state-dir", "/srv/state",
        "--content-store-dir", "/srv/store",
        "--content-runtime-dir", "/srv/runtime",
    ]), {
        outputPath: "assets/cdn/manifest.json",
        pathOverrides: {
            CDN_DIR: "/srv/cdn",
            CONTENT_STATE_DIR: "/srv/state",
            CONTENT_STORE_DIR: "/srv/store",
            CONTENT_RUNTIME_DIR: "/srv/runtime",
        },
    })

    for (const argv of [
        ["--unknown"],
        ["--output"],
        ["--output", "a.json", "--output", "b.json"],
    ]) {
        assert.throws(() => parseArguments(argv))
    }
})

test("manifest CLI prints by default and writes only for explicit --output", async () => {
    const writes = []
    const stdout = { write: value => writes.push(["stdout", value]) }
    const mkdir = async value => writes.push(["mkdir", value])
    const writeFile = async (filePath, value) => writes.push(["file", filePath, value])

    assert.equal(await executeManifestCli([], {
        runManifest: async () => ({ serialized: "stdout manifest\n", outputPath: null }),
        stdout,
        mkdir,
        writeFile,
        setExitCode() {},
    }), 0)
    assert.deepEqual(writes, [["stdout", "stdout manifest\n"]])

    writes.length = 0
    const outputPath = path.resolve("assets/cdn/manifest.json")
    assert.equal(await executeManifestCli(["--output", "assets/cdn/manifest.json"], {
        runManifest: async () => ({ serialized: "file manifest\n", outputPath }),
        stdout,
        mkdir,
        writeFile,
        setExitCode() {},
    }), 0)
    assert.deepEqual(writes, [
        ["mkdir", path.dirname(outputPath)],
        ["file", outputPath, "file manifest\n"],
    ])
})

test("manifest CLI refuses output inside the CDN or runtime directory", async () => {
    const paths = {
        cdnDir: "/srv/cdn",
        cdnRoot: "/srv/cdn/cn",
        contentStoreDir: "/srv/store",
        contentStateDir: "/srv/state",
        contentRuntimeDir: "/srv/runtime",
    }
    for (const outputPath of [
        "/srv/cdn/cn/catalog.json",
        "/srv/runtime/catalog.json",
    ]) {
        await assert.rejects(() => run(["--output", outputPath], {
            cwd: "/",
            resolvePaths: () => paths,
            scanCatalogInput: async () => { throw new Error("scan must not run") },
        }), error => (
            error instanceof ManifestCliError
            && error.code === "MANIFEST_OUTPUT_FORBIDDEN"
        ))
    }
})

test("tracked official manifest is the path-safe 1.4.54 baseline with 677 archives", () => {
    const manifestPath = path.resolve(__dirname, "../assets/cdn/catalog-cn-1.4.54.json")
    const serialized = fs.readFileSync(manifestPath, "utf8")
    const manifest = parseCdnRuntimeManifest(JSON.parse(serialized))
    const catalog = buildCdnCatalog(manifest.catalogInput)

    assert.equal(manifest.baseline, "cn-1.4.54")
    assert.equal(manifest.catalogInput.archives.length, 677)
    assert.equal(catalog.targetVersion, "1.4.54")
    assert.equal(serializeCdnRuntimeManifest(manifest), serialized)
    assert.equal(serialized.includes("/Users/"), false)
    assert.equal(path.isAbsolute(manifest.entityLists.relativePath), false)
    assert.ok(manifest.catalogInput.archives.every(item => !path.isAbsolute(item.relativePath)))
})
