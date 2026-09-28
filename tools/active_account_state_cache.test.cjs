"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, test } = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-account-cache-"))
const secondDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-account-cache-2-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    resolvePlayerIdSync,
    saveAccountDefaultPlayer,
} = require("../src/data/activeAccount")

// Count fs syscalls the state read path makes, mirroring the methodology of
// tools/perf/active_account_resolve_benchmark.cjs.
const COUNTED = ["existsSync", "readFileSync", "statSync", "lstatSync", "accessSync", "renameSync", "mkdirSync"]
const counts = Object.create(null)
const originals = new Map()
for (const name of COUNTED) {
    counts[name] = 0
    originals.set(name, fs[name])
    fs[name] = (...args) => {
        counts[name]++
        return originals.get(name)(...args)
    }
}
function countedTotal() {
    return COUNTED.reduce((sum, name) => sum + counts[name], 0)
}
function resetCounts() {
    for (const name of COUNTED) counts[name] = 0
}

initializeDatabase()
const account = insertAccountSync({
    appId: "wf_cn", idpAlias: "", idpCode: "test", idpId: "active-account-cache", status: "normal",
})
const firstPlayerId = insertDefaultPlayerSync(account.id).id
// Production always has a state file (startup's restoreTimeOffset writes it);
// exercise the state-present read path rather than the ENOENT branch.
saveAccountDefaultPlayer(account.id, firstPlayerId)

test("repeated state reads validate with a single stat instead of the full syscall chain", () => {
    assert.equal(resolvePlayerIdSync(account.id), firstPlayerId, "first read resolves via the full path")

    resetCounts()
    resolvePlayerIdSync(account.id)
    const syscalls = countedTotal()
    assert.ok(syscalls <= 2,
        `cached read must not replay the ~13-syscall chain (got ${syscalls}: ${COUNTED.map(name => `${name}=${counts[name]}`).join(", ")})`)
})

test("in-process admin writes are visible to the next read", () => {
    const secondPlayerId = insertDefaultPlayerSync(account.id).id
    assert.equal(resolvePlayerIdSync(account.id), firstPlayerId)

    saveAccountDefaultPlayer(account.id, secondPlayerId)
    assert.equal(resolvePlayerIdSync(account.id), secondPlayerId,
        "saveAccountDefaultPlayer must invalidate the cached state")
})

test("external state rewrites are visible to the next read", () => {
    const stateFile = path.join(databaseDirectory, "state", "active_account.json")
    const raw = JSON.parse(originals.get("readFileSync").call(fs, stateFile, "utf-8"))
    raw.defaultPlayers[account.id] = firstPlayerId
    // Simulate another process rewriting the state file in place.
    fs.writeFileSync(stateFile, JSON.stringify(raw))
    for (const name of ["utimesSync"]) {
        // nudge mtime forward so the stat validation cannot rely on
        // same-instant writes; 2s comfortably exceeds mtime granularity.
        if (typeof fs[name] === "function") {
            const future = new Date(Date.now() + 2000)
            fs[name](stateFile, future, future)
        }
    }

    assert.equal(resolvePlayerIdSync(account.id), firstPlayerId,
        "an externally rewritten state must win over the cached copy")
})

test("switching DATA_DIR reads the other volume's state", () => {
    const secondStateDir = path.join(secondDataDirectory, "state")
    fs.mkdirSync(secondStateDir, { recursive: true })
    fs.writeFileSync(path.join(secondStateDir, "active_account.json"), JSON.stringify({
        activePlayerId: null,
        timeOffset: null,
        lastSetTime: null,
        defaultPlayers: {},
    }))
    process.env.DATA_DIR = secondDataDirectory
    try {
        // The account lives in the first volume's database; resolution needs
        // both the database and the state, so only exercise the state reader's
        // path-keying via a player-less account id.
        assert.equal(resolvePlayerIdSync(999999999), null)
    } finally {
        process.env.DATA_DIR = databaseDirectory
    }
    assert.equal(resolvePlayerIdSync(account.id), firstPlayerId)
})

after(() => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    fs.rmSync(secondDataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
