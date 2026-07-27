const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const ROOT = path.join(__dirname, "..")
const BUILD = path.join(ROOT, "tools", "gacha-faithful", "build_catalog.cjs")
const VERIFY = path.join(ROOT, "tools", "gacha-faithful", "verify_catalog.cjs")
const AUDIT = path.join(ROOT, "tools", "gacha-faithful", "audit_catalog.cjs")
const DECODE = path.join(ROOT, "tools", "gacha-faithful", "amf3_decode.cjs")

function run(script, args) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd: ROOT,
        encoding: "utf8",
    })
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "starpoint-seed-cli-"))
try {
    const amf3Path = path.join(temporaryRoot, "integer.amf3")
    fs.writeFileSync(amf3Path, Buffer.from([0x04, 0x2a]))
    const decoded = run(DECODE, [amf3Path])
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout)
    assert.equal(decoded.stdout.trim(), "42")

    const unknownMovie = run(BUILD, [
        "--output", path.join(temporaryRoot, "invalid-movie"),
        "--seed-start", "1",
        "--seed-end", "2",
        "--movies", "fse",
    ])
    assert.notEqual(unknownMovie.status, 0)
    assert.match(unknownMovie.stderr, /unsupported movie/i)

    const negativeSeed = run(BUILD, [
        "--output", path.join(temporaryRoot, "invalid-seed"),
        "--seed-start", "-1",
        "--seed-end", "2",
        "--movies", "normal",
    ])
    assert.notEqual(negativeSeed.status, 0)
    assert.match(negativeSeed.stderr, /seed range/i)

    const excessiveWorkers = run(BUILD, [
        "--output", path.join(temporaryRoot, "invalid-workers"),
        "--seed-start", "1",
        "--seed-end", "2",
        "--movies", "normal",
        "--workers", "5",
    ])
    assert.notEqual(excessiveWorkers.status, 0)
    assert.match(excessiveWorkers.stderr, /workers.*1\.\.4/i)

    const built = run(BUILD, [
        "--output", temporaryRoot,
        "--seed-start", "1",
        "--seed-end", "12",
        "--movies", "normal,fes",
        "--workers", "2",
        "--client-version", "1.8.1",
        "--cdn-version", "1.4.54",
    ])
    assert.equal(built.status, 0, built.stderr || built.stdout)
    assert.match(built.stdout, /2 workers/i)

    const manifest = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "manifest.json"), "utf8"))
    assert.deepStrictEqual(manifest.movieIds, ["fes", "normal"])
    assert.deepStrictEqual(manifest.seedRange, { start: 1, end: 12 })
    assert.match(manifest.configDigest, /^[a-f0-9]{64}$/)
    assert.match(manifest.predictorDigest, /^[a-f0-9]{64}$/)

    const verified = run(VERIFY, ["--catalog", temporaryRoot])
    assert.equal(verified.status, 0, verified.stderr || verified.stdout)
    assert.match(verified.stdout, /verified 24 seeds across 2 movies/i)

    const manifestPath = path.join(temporaryRoot, "manifest.json")
    const originalManifest = fs.readFileSync(manifestPath, "utf8")
    const changedManifest = JSON.parse(originalManifest)
    changedManifest.configDigest = "0".repeat(64)
    fs.writeFileSync(manifestPath, JSON.stringify(changedManifest))
    const rejectedManifest = run(VERIFY, ["--catalog", temporaryRoot])
    assert.notEqual(rejectedManifest.status, 0)
    assert.match(rejectedManifest.stderr, /config digest mismatch/i)
    fs.writeFileSync(manifestPath, originalManifest)

    const auditPath = path.join(temporaryRoot, "audit.json")
    const audited = run(AUDIT, ["--catalog", temporaryRoot, "--output", auditPath])
    assert.equal(audited.status, 0, audited.stderr || audited.stdout)
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"))
    assert.equal(audit.totalSeedCount, 24)
    assert.deepStrictEqual(audit.movies.normal.finalRarityCounts, { "3": 8, "4": 4, "5": 0 })
    assert.equal(audit.movies.normal.moviePlayableCount, 1)
    assert.deepStrictEqual(audit.movies.normal.frameCountDistribution, { "0": 11, "203": 1 })
    assert.deepStrictEqual(audit.movies.fes.rarityUpgradeCountDistribution, { "0": 10, "1": 1, "2": 1 })

    const fesPath = path.join(temporaryRoot, "fes.json")
    const fes = JSON.parse(fs.readFileSync(fesPath, "utf8"))
    fes["1"]["0"].pop()
    fs.writeFileSync(fesPath, JSON.stringify(fes))

    const rejected = run(VERIFY, ["--catalog", temporaryRoot])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /missing seed|digest mismatch/i)
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

console.log("gacha seed catalog CLI tests passed")
