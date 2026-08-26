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
    "src/lib/reward-grant/owner-currency.ts",
    "src/lib/reward-grant/owner-executor.ts",
    "src/lib/reward-grant/known-player.ts",
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
    assert.match(withinTransaction, /normalizeRewardGrantPlanInternal\s*\(/)
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
    assert.match(standalone, /normalizeRewardGrantPlanInternal\s*\(/)
    assert.match(standalone, /executeNormalizedRewardGrantPlanSync\s*\(/)
    assert.doesNotMatch(standalone, /executeRewardGrantPlanWithinTransactionSync\s*\(/)
    assert.ok(
        standalone.indexOf("normalizeRewardGrantPlan") < standalone.indexOf(".transaction"),
        "standalone normalization must finish before opening its transaction",
    )
})

test("transaction-owner execution is strongly named and adds no savepoint or player reads", () => {
    const executor = readSource("src/lib/reward-grant/owner-executor.ts")
    const internalOwner = exportedFunctionSource(
        executor,
        "executeRewardGrantPlanInTransactionOwnerInternalSync",
        "export function executeRewardGrantPlanInTransactionOwnerSync",
    )
    const publicOwner = exportedFunctionSource(
        executor,
        "executeRewardGrantPlanInTransactionOwnerSync",
        null,
    )

    assert.match(internalOwner, /(?:getDb\(\)|db)\.inTransaction/)
    assert.match(internalOwner, /normalizeRewardGrantPlanInternal\s*\(/)
    assert.match(internalOwner, /knownPlayerBefore/)
    assert.doesNotMatch(internalOwner, /\.transaction\s*\(/)
    assert.doesNotMatch(internalOwner, /getPlayerSync\s*\(/)
    assert.ok(
        internalOwner.indexOf("inTransaction") < internalOwner.indexOf("normalizeRewardGrantPlan"),
        "transaction state must be checked before normalization",
    )
    assert.match(publicOwner, /projectPublicRewardGrantResult\s*\(/)
    assert.match(publicOwner, /executeRewardGrantPlanInTransactionOwnerInternalSync\s*\(/)
})

test("safe within and standalone executors share a private body that checks the player first", () => {
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

test("public barrel excludes the internal transaction-owner entry", () => {
    const index = readSource("src/lib/reward-grant/index.ts")
    const types = readSource("src/lib/reward-grant/types.ts")
    const owner = readSource("src/lib/reward-grant/owner-executor.ts")

    assert.doesNotMatch(index, /export \* from ["']\.\/executor["']/)
    assert.doesNotMatch(index, /executeRewardGrantPlanInTransactionOwnerSync/)
    assert.doesNotMatch(index, /executeRewardGrantPlanInTransactionOwnerInternalSync/)
    assert.doesNotMatch(types, /itemDeltas/)
    assert.match(owner, /executeRewardGrantPlanInTransactionOwnerInternalSync/)
    assert.match(index, /executeRewardGrantPlanWithinTransactionSync/)
    assert.match(index, /executeRewardGrantPlanSync/)
})

test("only approved standard reward domains and single settlement paths consume reward grants", () => {
    const consumers = sourceFilesBelow("src")
        .filter(relativePath => !relativePath.startsWith("src/lib/reward-grant/"))
        .filter(relativePath => /reward-grant/.test(readSource(relativePath)))

    assert.deepEqual(consumers, [
        "src/lib/carnival-rewards.ts",
        "src/lib/gacha-reward-grant.ts",
        "src/lib/gacha-reward-legacy.ts",
        "src/lib/gacha.ts",
        "src/lib/login-bonus.ts",
        "src/lib/mail-reward-grant.ts",
        "src/lib/mission/grants.ts",
        "src/lib/quest/finish/single-settlement-response-state.ts",
        "src/lib/quest/finish/single-settlement-reward-grant.ts",
        "src/lib/quest/finish/single-settlement-writes.ts",
        "src/lib/quest/finish/single-standard-reward-callbacks.ts",
        "src/lib/quest/score-reward-normalization.ts",
        "src/lib/quest/score-reward-projection.ts",
        "src/lib/quest/score-reward-selection-core.ts",
        "src/lib/quest/score-reward-selection.ts",
        "src/lib/quest/score-reward-settlement.ts",
        "src/lib/scheduled-resource-settlement.ts",
        "src/lib/shop-reward-grant.ts",
        "src/routes/api/gacha.ts",
        "src/routes/api/mail.ts",
        "src/routes/api/shop.ts",
        "src/routes/api/tutorial.ts",
    ])
})
