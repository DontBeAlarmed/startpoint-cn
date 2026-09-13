#!/usr/bin/env node
"use strict"

/**
 * Repeatable micro-benchmark for resolvePlayerIdSync's state-file read path
 * (src/data/activeAccount.ts readState → prepareDataVolume + readFileSync +
 * JSON.parse). Methodology: fixed Node process, temp DATA_DIR with an
 * initialized database, hot OS page cache, N iterations after warmup, with
 * fs syscall counts captured by wrapping the fs module functions the read
 * path uses. Run: node tools/perf/active_account_resolve_benchmark.cjs
 */

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { performance } = require("node:perf_hooks")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-account-bench-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")
const restoreContentSnapshot = require("../helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../../src/data")
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
const { resolvePlayerIdSync } = require("../../src/data/activeAccount")

const COUNTED_FUNCTIONS = [
    "existsSync", "readFileSync", "writeFileSync", "statSync", "lstatSync",
    "accessSync", "mkdirSync", "renameSync", "openSync", "closeSync", "realpathSync",
]
const syscallCounts = Object.create(null)
const originals = new Map()
for (const name of COUNTED_FUNCTIONS) {
    if (typeof fs[name] !== "function") continue
    syscallCounts[name] = 0
    originals.set(name, fs[name])
    fs[name] = (...args) => {
        syscallCounts[name]++
        return originals.get(name)(...args)
    }
}
function resetSyscallCounts() {
    for (const name of Object.keys(syscallCounts)) syscallCounts[name] = 0
}
function syscallTotal() {
    return Object.values(syscallCounts).reduce((sum, count) => sum + count, 0)
}

function summarize(label, iterations, run) {
    resetSyscallCounts()
    run() // warmup single call excluded from timing
    resetSyscallCounts()
    const samples = []
    // Interleave repeat batches to average out scheduler noise.
    for (let batch = 0; batch < 5; batch++) {
        const started = performance.now()
        for (let i = 0; i < iterations / 5; i++) run()
        samples.push((performance.now() - started) / (iterations / 5))
    }
    samples.sort((a, b) => a - b)
    const median = samples[2]
    const spread = samples[4] - samples[0]
    const calls = iterations
    console.log(
        `${label}: median ${median.toFixed(4)} ms/call`
        + ` (min-batch ${(samples[0]).toFixed(4)}, max-batch ${(samples[4]).toFixed(4)}, spread ${spread.toFixed(4)})`
        + `; syscalls/call ${(syscallTotal() / calls).toFixed(2)}`
        + ` (${COUNTED_FUNCTIONS.filter(name => syscallCounts[name] > 0)
            .map(name => `${name}=${syscallCounts[name]}`).join(", ")})`,
    )
}

initializeDatabase()
const account = insertAccountSync({
    appId: "wf_cn", idpAlias: "", idpCode: "bench", idpId: "active-account-bench", status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
// Production always has a state file (startup's restoreTimeOffset writes it);
// mirror that shape so the benchmark measures the hot read path, not the
// no-state-file ENOENT branch.
const { saveAccountDefaultPlayer } = require("../../src/data/activeAccount")
saveAccountDefaultPlayer(account.id, playerId)

const resolved = resolvePlayerIdSync(account.id)
if (resolved !== playerId) {
    throw new Error(`benchmark setup failed: resolved ${resolved}, expected ${playerId}`)
}

const ITERATIONS = 5000
summarize("resolvePlayerIdSync (hot, 5000 calls)", ITERATIONS, () => {
    resolvePlayerIdSync(account.id)
})

// A second account with no defaultPlayers entry exercises the fallback branch
// through the same state read.
const account2 = insertAccountSync({
    appId: "wf_cn", idpAlias: "", idpCode: "bench", idpId: "active-account-bench-2", status: "normal",
})
insertDefaultPlayerSync(account2.id)
summarize("resolvePlayerIdSync fallback (hot, 5000 calls)", ITERATIONS, () => {
    resolvePlayerIdSync(account2.id)
})

closeDatabase()
restoreContentSnapshot()
fs.rmSync(databaseDirectory, { recursive: true, force: true })
