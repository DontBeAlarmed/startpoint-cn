"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), "utf8")

test("shared battle settlement plans remain independent from lifecycle owners", () => {
    for (const relativePath of [
        "src/lib/quest/finish/battle-settlement-values.ts",
        "src/lib/quest/finish/battle-quest-progress-plan.ts",
    ]) {
        const source = read(relativePath)
        for (const forbidden of [
            /from\s+["'][^"']*data\//,
            /from\s+["'][^"']*multi\//,
            /from\s+["'][^"']*routes\//,
            /active-quest-service/,
            /getDb|\.transaction\s*\(/,
            /Fastify|coordinator|roomNumber|battleSessionId/,
        ]) assert.doesNotMatch(source, forbidden, `${relativePath}: ${forbidden}`)
    }
})

test("Single and Multi adapters explicitly consume the finite shared plans", () => {
    const singleValues = read("src/lib/quest/finish/single-settlement-value-plan.ts")
    const singleProgress = read("src/lib/quest/finish/single-quest-progress-write.ts")
    const multiValues = read("src/multi/settlement/value-plan.ts")
    const multiProgress = read("src/multi/settlement/quest-progress-write.ts")

    assert.match(singleValues, /createBattleSettlementValuePlan\s*\(/)
    assert.match(multiValues, /createBattleSettlementValuePlan\s*\(/)
    assert.match(singleProgress, /createBattleQuestProgressPlan\s*\(/)
    assert.match(multiProgress, /createBattleQuestProgressPlan\s*\(/)
    assert.match(singleProgress, /missingLeader:\s*["']preserve["']/)
    assert.match(multiProgress, /missingLeader:\s*["']clear["']/)
})

test("lifecycle state stays outside the finite shared core", () => {
    const single = read("src/lib/quest/finish/single-settlement-writes.ts")
    const multi = read("src/multi/settlement/orchestrator.ts")
    const shared = [
        read("src/lib/quest/finish/battle-settlement-values.ts"),
        read("src/lib/quest/finish/battle-quest-progress-plan.ts"),
    ].join("\n")

    assert.match(single, /settleSingleEntryResources\s*\(/)
    assert.match(single, /deletePlayerActiveQuestSync\s*\(/)
    assert.match(multi, /runMultiActiveQuestSettlementTransaction\s*\(/)
    assert.match(multi, /incrementPlayerQuestMultiClearSync\s*\(/)
    assert.match(multi, /publishCharacterGrowthOwnerStateBestEffort\s*\(/)
    assert.doesNotMatch(shared, /continue|abort|coordinator|session|activeQuests/)
})
