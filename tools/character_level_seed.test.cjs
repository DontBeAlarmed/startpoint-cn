"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const childProcess = require("node:child_process")
const crypto = require("node:crypto")
const test = require("node:test")
const zlib = require("node:zlib")

require("ts-node/register/transpile-only")

const { canonicalJsonBuffer } = require("../src/content/sync/canonical-json")
const { serializeNestedOrderedMap, serializeOrderedMap } = require("./orderedmap_serializer.cjs")
const {
    CHARACTER_LEVEL_BUNDLED_ARCHIVE_PATH,
    canonicalizeCharacterLevelBundledSeed,
    parseCharacterLevelBundledSourceBlob,
} = require("../src/content/character-level-seed")

const projectRoot = path.resolve(__dirname, "..")
const trackedSeedPath = path.join(
    projectRoot,
    "assets/content-seeds/character_level_apk_3_5.json",
)

function runTool(args) {
    return childProcess.spawnSync(
        process.execPath,
        [path.join(projectRoot, "tools/character-level-seed.cjs"), ...args],
        { cwd: projectRoot, encoding: "utf8" },
    )
}

function writeJson(directory, name, value) {
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8")
    return filePath
}

test("seed tool validates tracked metadata without writing output", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const outputPath = path.join(directory, "canonical.json")
    const result = runTool(["--input", trackedSeedPath])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(outputPath), false)
})

test("seed tool refuses to write a canonical seed without source blob evidence", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const outputPath = path.join(directory, "canonical.json")
    const result = runTool([
        "--input", trackedSeedPath,
        "--output", outputPath,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /source blob.*required/i)
    assert.equal(fs.existsSync(outputPath), false)
})

function sourceBlobForCurves(curves) {
    const outer = Object.entries(curves).map(([rarity, curve]) => {
        const levels = Object.entries(curve).map(([level, value]) => ({
            key: level,
            row: `${value}`,
        }))
        return { key: rarity, row: serializeOrderedMap(levels) }
    })
    return zlib.deflateRawSync(serializeNestedOrderedMap(outer))
}

function simpleCurves() {
    return Object.fromEntries(["3", "4", "5"].map((rarity, rarityIndex) => [
        rarity,
        Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
            String(index + 1), index === 0 ? 0 : index * (rarityIndex + 1) * 10,
        ])),
    ]))
}

function seedForCurves(curves, blobSha256) {
    return {
        schemaVersion: 1,
        source: {
            archiveLogicalPath: CHARACTER_LEVEL_BUNDLED_ARCHIVE_PATH,
            blobSha256,
        },
        summary: {
            rarities: [3, 4, 5],
            levelsPerRarity: 100,
            curves: Object.fromEntries(Object.entries(curves).map(([rarity, curve]) => [
                rarity,
                {
                    level80: curve["80"],
                    level90: curve["90"],
                    level100: curve["100"],
                    digest: require("../src/content/sync/canonical-json").sha256Object(
                        canonicalJsonBuffer(curve),
                    ),
                },
            ])),
        },
        curves: Object.fromEntries(Object.entries(curves).map(([rarity, curve]) => [
            rarity,
            Object.values(curve),
        ])),
    }
}

test("source blob extraction independently reconstructs all bundled curves", () => {
    const curves = simpleCurves()
    const sourceBlob = sourceBlobForCurves(curves)
    assert.deepEqual(parseCharacterLevelBundledSourceBlob(sourceBlob), curves)
})

test("canonical seed rejects curves that disagree with extracted source blob", () => {
    const curves = simpleCurves()
    const sourceBlob = sourceBlobForCurves(curves)
    const sourceBlobSha256 = crypto.createHash("sha256").update(sourceBlob).digest("hex")
    const seed = seedForCurves(curves, sourceBlobSha256)
    const changed = structuredClone(seed)
    changed.curves["3"][40] += 1
    changed.summary.curves["3"].level80 = changed.curves["3"][79]
    changed.summary.curves["3"].digest = require("../src/content/sync/canonical-json").sha256Object(
        canonicalJsonBuffer(Object.fromEntries(changed.curves["3"].map((value, index) => [
            String(index + 1), value,
        ]))),
    )

    assert.throws(
        () => canonicalizeCharacterLevelBundledSeed(changed, sourceBlobSha256, sourceBlob),
        /do not match source blob/i,
    )
})

test("seed tool writes canonical output only after source curve comparison", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const curves = simpleCurves()
    const sourceBlobPath = path.join(directory, "source.blob")
    const sourceBlob = sourceBlobForCurves(curves)
    fs.writeFileSync(sourceBlobPath, sourceBlob)
    const sourceBlobSha256 = crypto.createHash("sha256").update(sourceBlob).digest("hex")
    const inputPath = writeJson(directory, "seed.json", seedForCurves(curves, sourceBlobSha256))
    const outputPath = path.join(directory, "canonical.json")
    const result = runTool([
        "--input", inputPath,
        "--source-blob", sourceBlobPath,
        "--output", outputPath,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
        fs.readFileSync(outputPath),
        canonicalJsonBuffer(JSON.parse(fs.readFileSync(inputPath, "utf8"))),
    )
})

test("seed tool rejects source drift, summary drift, and malformed curves", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const base = JSON.parse(fs.readFileSync(trackedSeedPath, "utf8"))
    const invalidSeeds = [
        (() => {
            const seed = structuredClone(base)
            seed.source.archiveLogicalPath = "production/android_bundle/other"
            return seed
        })(),
        (() => {
            const seed = structuredClone(base)
            seed.summary.curves["4"].digest = `sha256:${"0".repeat(64)}`
            return seed
        })(),
        (() => {
            const seed = structuredClone(base)
            seed.curves["3"].pop()
            return seed
        })(),
        (() => {
            const seed = structuredClone(base)
            seed.curves["5"][40] = seed.curves["5"][39]
            return seed
        })(),
    ]

    invalidSeeds.forEach((seed, index) => {
        const inputPath = writeJson(directory, `invalid-${index}.json`, seed)
        const result = runTool(["--input", inputPath])
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /invalid character level seed/i)
    })
})

test("seed tool verifies an optional extracted source blob SHA", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const blobPath = path.join(directory, "source.blob")
    fs.writeFileSync(blobPath, "not-the-authoritative-blob", "utf8")
    const result = runTool([
        "--input", trackedSeedPath,
        "--source-blob", blobPath,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /blob SHA-256/i)
})
