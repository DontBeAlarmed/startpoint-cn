require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { GachaSeedQuarantine } = require("../src/lib/gacha-seed-quarantine.ts")

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "starpoint-seed-quarantine-"))
const stateFile = path.join(temporaryRoot, "quarantine.json")
let now = 1_000_000

try {
    const quarantine = new GachaSeedQuarantine({
        stateFile,
        now: () => now,
        recentTtlMs: 60_000,
    })

    assert.equal(quarantine.quarantineIfRecentlySent("normal", 101), false)
    assert.equal(quarantine.isQuarantined("normal", 101), false)
    assert.equal(fs.existsSync(stateFile), false, "untrusted reports must not create state")

    quarantine.markSent("normal", 101, 5)
    assert.equal(quarantine.quarantineIfRecentlySent("fes", 101), false)
    assert.equal(quarantine.quarantineIfRecentlySent("normal", 101), true)
    assert.equal(quarantine.isQuarantined("normal", 101), true)
    assert.equal(quarantine.isQuarantined("fes", 101), false)

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    assert.deepStrictEqual(persisted, {
        schemaVersion: 1,
        movies: { normal: [101] },
    })

    assert.equal(quarantine.quarantineIfRecentlySent("normal", 101), false)

    quarantine.markSent("fes", 202, 4)
    now += 60_000
    assert.equal(quarantine.quarantineIfRecentlySent("fes", 202), false)
    assert.equal(quarantine.isQuarantined("fes", 202), false)

    const reloaded = new GachaSeedQuarantine({ stateFile, now: () => now })
    assert.equal(reloaded.isQuarantined("normal", 101), true)
    assert.deepStrictEqual(reloaded.stats(), {
        total: 1,
        movies: { normal: 1 },
    })

    let failWrite = true
    const retryable = new GachaSeedQuarantine({
        stateFile: path.join(temporaryRoot, "retryable.json"),
        now: () => now,
        writeSnapshot() {
            if (failWrite) throw new Error("simulated quarantine write failure")
        },
    })
    retryable.markSent("fes", 303, 5)
    assert.throws(
        () => retryable.quarantineIfRecentlySent("fes", 303),
        /simulated quarantine write failure/,
    )
    assert.equal(retryable.isQuarantined("fes", 303), false)
    failWrite = false
    assert.equal(retryable.quarantineIfRecentlySent("fes", 303), true)

    fs.writeFileSync(stateFile, "{}")
    const warnings = []
    const recovered = new GachaSeedQuarantine({
        stateFile,
        logger: { warn: message => warnings.push(message) },
    })
    assert.deepStrictEqual(recovered.stats(), { total: 0, movies: {} })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /invalid.*quarantine/i)
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

const cnServerSource = fs.readFileSync(path.join(__dirname, "..", "src", "cn-server.ts"), "utf8")
assert.match(cnServerSource, /quarantineIfRecentlySent/)
assert.doesNotMatch(cnServerSource, /parsePlayBeacon|moveToVerified|addPending|recordPlay/)

const gachaSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "gacha.ts"), "utf8")
assert.match(gachaSource, /gachaSeedQuarantine\.markSent/)
assert.doesNotMatch(gachaSource, /seedValidator/)

console.log("gacha seed quarantine tests passed")
