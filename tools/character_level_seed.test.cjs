"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const childProcess = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { canonicalJsonBuffer } = require("../src/content/sync/canonical-json")

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

test("seed tool validates tracked metadata and emits canonical seed JSON", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-character-level-seed-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const outputPath = path.join(directory, "canonical.json")
    const result = runTool([
        "--input", trackedSeedPath,
        "--output", outputPath,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
        fs.readFileSync(outputPath),
        canonicalJsonBuffer(JSON.parse(fs.readFileSync(trackedSeedPath, "utf8"))),
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
