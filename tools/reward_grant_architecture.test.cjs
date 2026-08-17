"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const productionFiles = [
    "src/lib/reward-grant/types.ts",
    "src/lib/reward-grant/plan.ts",
    "src/lib/reward-grant/executor.ts",
    "src/lib/reward-grant/index.ts",
]

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function exportedFunctionSource(source, functionName, nextMarker) {
    const start = source.indexOf(`export function ${functionName}`)
    const end = nextMarker === null ? source.length : source.indexOf(nextMarker, start)
    assert.ok(start >= 0 && end > start, `${functionName} source must be present`)
    return source.slice(start, end)
}

function sourceBetween(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, `${label} source must be present`)
    return source.slice(start, end)
}

function sourceFilesBelow(relativeDirectory) {
    const directory = path.join(projectRoot, relativeDirectory)
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) return sourceFilesBelow(relativePath)
        return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : []
    })
}

test("reward grant public production files stay focused and avoid quest dependencies", () => {
    for (const relativePath of productionFiles) {
        const source = readSource(relativePath)
        const lineCount = source.split("\n").length
        assert.ok(lineCount <= 300, `${relativePath} exceeds 300 lines: ${lineCount}`)
        assert.doesNotMatch(source, /from\s+["'][^"']*quest(?:\.ts)?["']/)
        assert.doesNotMatch(source, /\bany\b/)
    }
})

test("within-transaction execution normalizes before one plan savepoint", () => {
    const executor = readSource("src/lib/reward-grant/executor.ts")
    const withinTransaction = exportedFunctionSource(
        executor,
        "executeRewardGrantPlanWithinTransactionSync",
        "export function executeRewardGrantPlanSync",
    )

    assert.match(withinTransaction, /(?:getDb\(\)|db)\.inTransaction/)
    assert.match(withinTransaction, /normalizeRewardGrantPlan\s*\(/)
    assert.equal((withinTransaction.match(/\.transaction\s*\(/g) ?? []).length, 1)
    assert.match(withinTransaction, /executeNormalizedRewardGrantPlanSync\s*\(/)
    assert.ok(
        withinTransaction.indexOf("inTransaction") < withinTransaction.indexOf("normalizeRewardGrantPlan"),
        "transaction state must be checked before normalization",
    )
    assert.ok(
        withinTransaction.indexOf("normalizeRewardGrantPlan") < withinTransaction.indexOf(".transaction"),
        "normalization must finish before opening the plan savepoint",
    )
})

test("standalone execution normalizes before one transaction without calling within", () => {
    const executor = readSource("src/lib/reward-grant/executor.ts")
    const standalone = exportedFunctionSource(
        executor,
        "executeRewardGrantPlanSync",
        null,
    )

    assert.equal((standalone.match(/\.transaction\s*\(/g) ?? []).length, 1)
    assert.match(standalone, /normalizeRewardGrantPlan\s*\(/)
    assert.match(standalone, /executeNormalizedRewardGrantPlanSync\s*\(/)
    assert.doesNotMatch(standalone, /executeRewardGrantPlanWithinTransactionSync\s*\(/)
    assert.ok(
        standalone.indexOf("normalizeRewardGrantPlan") < standalone.indexOf(".transaction"),
        "standalone normalization must finish before opening its transaction",
    )
})

test("both public executors share a private body that checks the player first", () => {
    const executor = readSource("src/lib/reward-grant/executor.ts")
    const privateBody = sourceBetween(
        executor,
        "function executeNormalizedRewardGrantPlanSync",
        "export function executeRewardGrantPlanWithinTransactionSync",
        "normalized reward grant private body",
    )

    assert.match(privateBody, /getPlayerSync\s*\(/)
    assert.match(privateBody, /grantEntrySync\s*\(/)
    assert.ok(
        privateBody.indexOf("getPlayerSync") < privateBody.indexOf("grantEntrySync"),
        "player existence must be checked before grant writes",
    )
})

test("no existing production caller is migrated to the new reward grant module", () => {
    const consumers = sourceFilesBelow("src")
        .filter(relativePath => !relativePath.startsWith("src/lib/reward-grant/"))
        .filter(relativePath => /reward-grant/.test(readSource(relativePath)))

    assert.deepEqual(consumers, [])
})
