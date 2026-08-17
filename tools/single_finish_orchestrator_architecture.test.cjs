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
    assert.match(route, /validateSessionIdentity\s*\(\s*viewerId\s*\)/)
    assert.doesNotMatch(route, /validateSessionAndPlayer\s*\(/)
    assert.doesNotMatch(route, /\bplayerData\b/)
    for (const directResponsibility of [
        "getQuestFromCategorySync",
        "runSingleFinishSettlementTransaction",
        "settleAdditionalRewardsSync",
        "settleSingleBattleMissionCategories",
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
    assert.doesNotMatch(
        sourceBetween(
            orchestrator,
            "export function settleSingleBattleQuest",
            "runSingleFinishSettlementTransaction({",
            "single finish pre-transaction preparation",
        ),
        /getPlayerSingleQuestProgressSync\s*\(/,
    )
    assert.match(writes, /settleAdditionalRewardsSync\s*\(/)
    assert.match(writes, /settleSingleBattleMissionCategories\s*\(/)
    assert.match(writes, /handleRushEventFinish\s*\(/)
    assert.match(writes, /handleRaidEventFinish\s*\(/)
    assert.match(writes, /handleCarnivalEventFinish\s*\(/)
    assert.match(writes, /handleScoreAttackEventFinish\s*\(/)
})

test("single finish route delegates pure success response projection", () => {
    const route = finishHandlerSource(readSource("src/routes/api/singleBattleQuest.ts"))
    const projector = readSource("src/lib/quest/finish/single-response-projector.ts")
    const projectionCall = sourceBetween(
        route,
        "buildSingleFinishResponse({",
        "})\n        reply.header",
        "single finish response projection call",
    )

    assert.match(route, /buildSingleFinishResponse\s*\(\s*\{/)
    assert.match(projectionCall, /player:\s*\{[\s\S]*?finishResult\.finalPlayerProjection\.freeMana/)
    assert.match(projectionCall, /degreeId:\s*finishResult\.finalPlayerProjection\.degreeId/)
    assert.doesNotMatch(projectionCall, /playerSnapshot/)
    assert.doesNotMatch(projectionCall, /\bplayerData\b/)
    for (const directProjection of [
        "responseData",
        "mergeMissionSettlementResponse",
        "drop_score_reward_ids",
        "drop_rare_reward_ids",
        "drop_additional_reward_ids",
        "joined_character_id_list",
        "equipment_list",
    ]) {
        assert.doesNotMatch(
            route,
            new RegExp(`\\b${directProjection}\\b`),
            `${directProjection} must not remain in the route finish handler`,
        )
    }

    assert.match(projector, /mergeMissionSettlementResponse\s*\(/)
    assert.doesNotMatch(projector, /free_mana[\s\S]{0,400}\+\s*\(?(?:clearReward|sPlusClearReward|scoreRewardsResult|scoreAttackRewardResult|carnivalRewardResult)/)
    assert.doesNotMatch(projector, /free_vmoney[\s\S]{0,400}\+\s*\(?(?:clearReward|sPlusClearReward|scoreRewardsResult|scoreAttackRewardResult|carnivalRewardResult)/)
    assert.doesNotMatch(projector, /Record<string,\s*any>/)
    assert.match(
        projector,
        /export interface SingleFinishResponseHeaders\s*\{[\s\S]*?servertime:\s*number[\s\S]*?\[key:\s*string\]:\s*unknown[\s\S]*?\}/,
    )
    assert.match(projector, /export interface SingleFinishResponseData\s*\{/)
    assert.match(
        projector,
        /export interface SingleFinishResponseEnvelope\s*\{[\s\S]*?data_headers:\s*SingleFinishResponseHeaders[\s\S]*?data:\s*SingleFinishResponseData[\s\S]*?\}/,
    )
    assert.match(
        projector,
        /\}:\s*SingleFinishResponseProjectionInput\):\s*SingleFinishResponseEnvelope\s*\{/,
    )
    assert.match(projector, /const responseData:\s*SingleFinishResponseData\s*=\s*\{/)
    assert.match(route, /const generatedDataHeaders:\s*Record<string,\s*unknown>\s*=\s*generateDataHeaders/)
    assert.match(route, /typeof serverTime\s*!==\s*["']number["']/)
    assert.match(route, /const dataHeaders:\s*SingleFinishResponseHeaders\s*=\s*\{/)
    for (const forbiddenDependency of [
        /from\s+["'][^"']*data\//,
        /from\s+["']fastify["']/,
        /getServerTime/,
        /realToVirtual/,
        /getPlayerMailCountSync/,
        /getMailArrivedSync/,
    ]) {
        assert.doesNotMatch(projector, forbiddenDependency)
    }
})

test("single finish production files stay focused", () => {
    for (const relativePath of [
        "src/lib/quest/finish/single-orchestrator.ts",
        "src/lib/quest/finish/single-response-projector.ts",
        "src/lib/quest/finish/single-settlement-response-state.ts",
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
