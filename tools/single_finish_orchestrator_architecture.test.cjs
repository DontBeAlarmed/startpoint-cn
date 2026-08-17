"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function finishHandlerSource(routeSource) {
    const start = routeSource.indexOf('fastify.post("/finish"')
    const end = routeSource.indexOf('fastify.post("/abort"', start)
    assert.ok(start >= 0 && end > start, "single finish handler must be present")
    return routeSource.slice(start, end)
}

function sourceBetween(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, `${label} source block must be present`)
    return source.slice(start, end)
}

test("single finish route delegates preparation and settlement to the orchestrator", () => {
    const route = finishHandlerSource(readSource("src/routes/api/singleBattleQuest.ts"))
    const orchestrator = readSource("src/lib/quest/finish/single-orchestrator.ts")
    const writes = readSource("src/lib/quest/finish/single-settlement-writes.ts")

    assert.match(route, /settleSingleBattleQuest\s*\(\s*\{/)
    for (const directResponsibility of [
        "getQuestFromCategorySync",
        "runSingleFinishSettlementTransaction",
        "settleAdditionalRewardsSync",
        "settleMissionCategories",
        "handleRushEventFinish",
        "handleRaidEventFinish",
        "handleCarnivalEventFinish",
        "handleScoreAttackEventFinish",
    ]) {
        assert.doesNotMatch(
            route,
            new RegExp(`\\b${directResponsibility}\\b`),
            `${directResponsibility} must not remain in the route finish handler`,
        )
    }

    assert.match(orchestrator, /getQuestFromCategorySync\s*\(/)
    assert.match(orchestrator, /runSingleFinishSettlementTransaction\s*\(/)
    assert.match(writes, /settleAdditionalRewardsSync\s*\(/)
    assert.match(writes, /settleMissionCategories\s*\(/)
    assert.match(writes, /handleRushEventFinish\s*\(/)
    assert.match(writes, /handleRaidEventFinish\s*\(/)
    assert.match(writes, /handleCarnivalEventFinish\s*\(/)
    assert.match(writes, /handleScoreAttackEventFinish\s*\(/)
})

test("single finish production files stay focused", () => {
    for (const relativePath of [
        "src/lib/quest/finish/single-orchestrator.ts",
        "src/lib/quest/finish/single-settlement-writes.ts",
    ]) {
        const lineCount = readSource(relativePath).split("\n").length
        assert.ok(lineCount <= 330, `${relativePath} exceeds 330 lines: ${lineCount}`)
    }
})

test("single settlement writes derives duplicated values from authoritative inputs", () => {
    const orchestrator = readSource("src/lib/quest/finish/single-orchestrator.ts")
    const writes = readSource("src/lib/quest/finish/single-settlement-writes.ts")
    const callInput = sourceBetween(
        orchestrator,
        "executeSingleSettlementWrites({",
        "}, activeQuest, player)",
        "single settlement writes call input",
    )
    const inputInterface = sourceBetween(
        writes,
        "export interface SingleSettlementWritesInput {",
        "}\n\nexport function executeSingleSettlementWrites",
        "single settlement writes input interface",
    )
    const progressUpdate = sourceBetween(
        writes,
        "if (questAccomplished && !isScoreAttackEvent)",
        "const oldRkDegree",
        "single quest progress update",
    )

    for (const field of [
        "playerId",
        "questCategory",
        "questId",
        "clearTime",
        "clearRank",
        "questAccomplished",
        "questProgress",
        "isScoreAttackEvent",
        "leaderId",
        "questProgressExists",
        "partyCharacterIds",
    ]) {
        assert.doesNotMatch(
            callInput,
            new RegExp(`^\\s*${field}\\s*(?::|,)`, "m"),
            `caller must not pass derived ${field}`,
        )
        assert.doesNotMatch(
            inputInterface,
            new RegExp(`^\\s*${field}\\??\\s*:`, "m"),
            `writes input must not declare derived ${field}`,
        )
    }
    for (const retainedField of [
        "body",
        "questData",
        "rewardEligibility",
        "finishCtx",
        "rushEventFolderMaxRound",
        "scoreAttackBorderTiers",
    ]) {
        assert.match(
            callInput,
            new RegExp(`^\\s*${retainedField}\\s*(?::|,)`, "m"),
            `caller must pass authoritative ${retainedField}`,
        )
        assert.match(
            inputInterface,
            new RegExp(`^\\s*${retainedField}\\??\\s*:`, "m"),
            `writes input must declare authoritative ${retainedField}`,
        )
    }
    assert.doesNotMatch(writes, /questProgressExists/)
    assert.doesNotMatch(writes, /const updateData:\s*any/)
    assert.doesNotMatch(writes, /questProgress!\./)
    assert.match(
        progressUpdate,
        /const updateData:\s*Partial<PlayerQuestProgress>\s*&\s*Pick<PlayerQuestProgress,\s*["']questId["']>/,
    )
})
