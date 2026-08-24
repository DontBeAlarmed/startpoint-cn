require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const calls = []
stubModule("../src/lib/quest/finish/character-clear-tracker", {
    trackCharacterClears: ctx => calls.push(["character", ctx.questId]),
})
stubModule("../src/lib/quest/finish/leader-powerflip-tracker", {
    trackLeaderPowerflip: ctx => calls.push(["leader-powerflip", ctx.questId]),
})
stubModule("../src/lib/quest/finish/party-co-clear-tracker", {
    trackPartyCoClears: ctx => {
        calls.push(["party", ctx.questId])
        return [3310032, 3310033]
    },
})
stubModule("../src/lib/quest/finish/powerflip-tracker", {
    trackPowerflip: ctx => calls.push(["powerflip", ctx.questId]),
})
stubModule("../src/data/domains/quest", {
    incrementPlayerQuestMultiClearSync: (playerId, category, questId) => {
        calls.push(["multi", playerId, category, questId])
    },
})
stubModule("../src/data/domains/mission_battle_facts", {
    recordMissionBattleResultSync: (playerId, result) => {
        calls.push(["result", playerId, result])
    },
})
stubModule("../src/lib/mission/degree-battle-stat-facts", {
    recordDegreeBattleStatisticsSync: ctx => calls.push(["degree-stats", ctx.questId]),
})
stubModule("../src/lib/mission/daily-battle-facts", {
    recordDailyMissionBattleFacts: ctx => calls.push(["daily", ctx.questId]),
})
stubModule("../src/lib/mission/event-battle-facts", {
    recordEventMissionBattleFacts: ctx => calls.push(["event", ctx.questId]),
})
stubModule("../src/lib/mission/degree-battle-facts", {
    recordDegreeMissionBattleFacts: ctx => calls.push(["degree", ctx.questId]),
})
stubModule("../src/lib/mission/pass-battle-facts", {
    recordPassMissionBattleFacts: ctx => calls.push(["pass", ctx.questId]),
})
stubModule("../src/lib/mission/active-mission-specific-battle-facts", {
    recordActiveMissionSpecificBattleFactsSync: ctx => calls.push(["active-specific", ctx.questId]),
})
stubModule("../src/lib/mission/active-conditional-battle-facts", {
    recordActiveMissionConditionalBattleFactsSync: ctx => calls.push(["active-conditional", ctx.questId]),
})

const {
    BATTLE_SETTLEMENT_CATEGORIES,
    buildBattleMissionSettlementScopes,
    recordMissionBattleFacts,
} = require("../src/lib/mission/battle-facts")
const { getMissionMasterDefinitions } = require("../src/lib/mission/master-data")

assert.equal(
    typeof buildBattleMissionSettlementScopes,
    "function",
    "battle-facts 必须导出定向 settlement scope builder",
)
const battleScopes = buildBattleMissionSettlementScopes([111002, 111001, 111002, 0, -1])
assert.deepEqual(
    battleScopes.filter(scope => typeof scope === "number"),
    BATTLE_SETTLEMENT_CATEGORIES,
    "现有 battle settlement 分类及数字 scope 语义必须保持不变",
)
assert.equal(
    battleScopes.includes(2),
    true,
    "category 2 必须继续使用全量数字 scope",
)
const degreeScope = battleScopes.find(scope => typeof scope !== "number" && scope.category === 5)
assert.ok(degreeScope, "battle settlement 必须包含 category 5 定向 scope")
assert.equal(degreeScope.missionIds.includes(111001), true, "main 角色称号必须进入候选")
assert.equal(degreeScope.missionIds.includes(111002), true, "Sub 角色称号必须进入候选")
assert.equal(degreeScope.missionIds.includes(111003), false, "非本场角色的 type 44 不得进入候选")
assert.equal(degreeScope.missionIds.includes(32000), true, "本场战力称号必须进入候选")
assert.equal(degreeScope.missionIds.includes(35000), true, "本场最大伤害称号必须进入候选")
assert.equal(degreeScope.missionIds.includes(39000), true, "本场复活棺柩称号必须进入候选")
assert.equal(
    degreeScope.missionIds.length < getMissionMasterDefinitions(5).length,
    true,
    "battle category 5 候选必须小于全量 1288",
)

const baseContext = {
    playerId: 1,
    questCategory: 1,
    questId: 1001,
    clearTime: 1000,
    clearRank: 1,
    party: { characters: [], unison_characters: [] },
    statistics: {
        clear_phase: 0,
        party: { characters: [], unison_characters: [] },
        zones: [{ use_skill_count: 2 }, { use_skill_count: 3 }],
    },
    player: {},
    questPreviouslyCompleted: false,
    questProgress: null,
}

const failedResult = recordMissionBattleFacts({ ...baseContext, questAccomplished: false })
assert.deepEqual(failedResult, { awakeMissionIds: [] })
assert.deepEqual(calls, [["result", 1, {
    isMulti: false,
    questCategory: 1,
    isHost: undefined,
    accomplished: false,
    clearRank: 1,
    score: undefined,
    clearTime: 1000,
    skillUseCount: 0,
}], ["pass", 1001]])
assert.equal(calls.some(([kind]) => kind === "party"), false, "failed settlement must not call direct awake tracker")

const completedResult = recordMissionBattleFacts({
    ...baseContext,
    questAccomplished: true,
    isMulti: true,
    isMultiHost: true,
})
assert.deepEqual(completedResult, { awakeMissionIds: [3310032, 3310033] })
assert.deepEqual(calls, [
    ["result", 1, {
        isMulti: false,
        questCategory: 1,
        isHost: undefined,
        accomplished: false,
        clearRank: 1,
        score: undefined,
        clearTime: 1000,
        skillUseCount: 0,
    }],
    ["pass", 1001],
    ["result", 1, {
        isMulti: true,
        questCategory: 1,
        isHost: true,
        accomplished: true,
        clearRank: 1,
        score: undefined,
        clearTime: 1000,
        skillUseCount: 5,
    }],
    ["pass", 1001],
    ["degree-stats", 1001],
    ["daily", 1001],
    ["event", 1001],
    ["degree", 1001],
    ["active-specific", 1001],
    ["active-conditional", 1001],
    ["multi", 1, 1, 1001],
    ["character", 1001],
    ["leader-powerflip", 1001],
    ["party", 1001],
    ["powerflip", 1001],
])

const singleBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-settlement-writes.ts"),
    "utf8",
)
const singleOrchestratorSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-orchestrator.ts"),
    "utf8",
)
const singleProjectorSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-response-projector.ts"),
    "utf8",
)
const singleMissionPublicationSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest/finish/single-mission-publication.ts"),
    "utf8",
)
const singleTransactionStart = singleBattleSource.indexOf("export function executeSingleSettlementWrites(")
const singleEvaluationTime = singleBattleSource.indexOf(
    "const settlementTime = new Date(getServerTime() * 1000)",
    singleTransactionStart,
)
const singleFactCall = singleBattleSource.indexOf(
    "recordMissionBattleFacts(finishCtx, settlementTime)",
    singleEvaluationTime,
)
const singleCharacterExp = singleBattleSource.indexOf(
    "givePlayerCharactersExpSync(",
    singleFactCall,
)
const singleMissionEvaluationCall = singleBattleSource.indexOf(
    "settleSingleMissionEvaluations({",
    singleCharacterExp,
)
const singleSettlementTime = singleMissionPublicationSource.indexOf(
    "settleMissionCategoriesWithEvaluation(",
)
const singleAwakeSettlement = singleMissionPublicationSource.indexOf(
    "settleAwakeMissionCandidatesWithEvaluation(",
    singleSettlementTime,
)
const singleAwakeFinalization = singleBattleSource.indexOf(
    "finalizeSingleAwakePublicationWrites(playerId, isScoreAttackEvent)",
    singleMissionEvaluationCall,
)
const singleAwakePublication = singleBattleSource.indexOf(
    "publishAwakeCharacterListBestEffort(",
    singleAwakeFinalization,
)
const singleGeneralMerge = singleProjectorSource.indexOf(
    "...missionSettlement,",
)
const singleAwakeMerge = singleProjectorSource.indexOf(
    "...awakeMissionSettlement,",
    singleGeneralMerge,
)
const singleTransactionCall = singleOrchestratorSource.indexOf(
    "transactionResult = runSingleFinishSettlementTransaction({",
)
const singleTransactionBinding = singleOrchestratorSource.indexOf(
    "settle: ({ activeQuest, player, questProgress }) => {",
    singleTransactionCall,
)
const singleWritesBinding = singleOrchestratorSource.indexOf(
    "executeSingleSettlementWrites({",
    singleTransactionBinding,
)
assert.equal(singleEvaluationTime > singleTransactionStart, true, "单人 finish 必须在事务体内固定任务时间")
assert.equal(singleFactCall > singleEvaluationTime, true, "单人任务事实必须使用事务时间")
assert.equal(singleCharacterExp > singleFactCall, true, "单人角色经验必须在任务事实后写入")
assert.equal(singleMissionEvaluationCall > singleCharacterExp, true, "单人称号结算必须看到本场角色经验")
assert.equal(singleSettlementTime >= 0, true, "单人 finish 必须调用通用任务结算")
assert.equal(singleAwakeSettlement >= 0, true, "单人 finish 必须把本场 facts 传入觉醒 seam")
assert.equal(singleAwakeSettlement > singleSettlementTime, true, "单人觉醒 seam 必须位于通用结算之后")
assert.equal(singleAwakeFinalization > singleMissionEvaluationCall, true, "单人 finish 必须在任务结算后清理 active quest")
assert.equal(singleAwakePublication > singleAwakeFinalization, true, "单人 character_list 必须在 active quest 清理后发布")
assert.equal(singleGeneralMerge >= 0 && singleAwakeMerge > singleGeneralMerge, true, "单人响应必须先合并通用结算再合并觉醒结算")
assert.match(
    singleBattleSource,
    /publishAwakeCharacterListBestEffort\(\s*playerId,\s*partyCharacterIds,[\s\S]*?awakePublication\.characterLists/,
    "单人 character_list 必须在 reconcile 前包含觉醒奖励与解锁更新",
)
assert.match(
    singleBattleSource,
    /const characterId = value\?\.id[\s\S]*?Number\.isSafeInteger\(characterId\)[\s\S]*?characterId > 0[\s\S]*?partyCharacterIds\.push\(characterId\)/,
    "单人 finish 必须只收集 main/Sub 的有效正整数角色 ID",
)
assert.equal(singleTransactionCall >= 0, true, "单人写入闭包必须交给 finish 事务")
assert.equal(singleTransactionBinding > singleTransactionCall, true, "所有单人同步结算写入必须共享事务")
assert.equal(singleWritesBinding > singleTransactionBinding, true, "单人写入必须在事务回调内执行")

const multiBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/settlement/orchestrator.ts"),
    "utf8",
)
const multiResponseSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/settlement/response.ts"),
    "utf8",
)
const multiTransactionStart = multiBattleSource.indexOf("const executeFinishWrites =")
const multiEvaluationTime = multiBattleSource.indexOf(
    "const settlementTime = new Date(getServerTime() * 1000)",
    multiTransactionStart,
)
const multiFactCall = multiBattleSource.indexOf(
    "recordMissionBattleFacts(finishCtx, settlementTime)",
    multiEvaluationTime,
)
const multiCharacterExp = multiBattleSource.indexOf(
    "givePlayerCharactersExpSync(",
    multiFactCall,
)
const multiSettlementTime = multiBattleSource.indexOf(
    "buildBattleMissionSettlementScopes(partyCharacterIdsArray),\n            settlementTime,",
    multiFactCall,
)
const multiAwakeSettlement = multiBattleSource.indexOf(
    "settleAwakeMissionCandidatesWithEvaluation(",
    multiSettlementTime,
)
const multiGeneralMerge = multiResponseSource.indexOf(
    "mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)",
)
const multiAwakeMerge = multiResponseSource.indexOf(
    "mergeMissionSettlementResponse(responseData, awakeMissionSettlement, viewerId)",
    multiGeneralMerge,
)
const multiTransactionCall = multiBattleSource.indexOf("runMultiActiveQuestSettlementTransaction(")
const multiActiveDelete = multiBattleSource.indexOf("delete activeQuests[input.playerId]", multiTransactionCall)
const multiCoordinatorFinalize = multiBattleSource.indexOf("context.coordinator.finalizeBattle({")
assert.equal(multiTransactionStart >= 0, true, "多人 finish 必须定义同步结算事务体")
assert.equal(multiEvaluationTime > multiTransactionStart, true, "多人 finish 必须在事务体内固定任务时间")
assert.equal(multiFactCall > multiTransactionStart, true)
assert.equal(multiCharacterExp > multiFactCall, true, "多人角色经验必须在任务事实后写入")
assert.equal(multiSettlementTime > multiCharacterExp, true, "多人称号结算必须看到本场角色经验")
assert.equal(multiAwakeSettlement > multiFactCall, true, "多人 finish 必须把本场 facts 传入觉醒 seam")
assert.equal(multiAwakeSettlement > multiSettlementTime, true, "多人觉醒 seam 必须位于通用结算之后")
assert.equal(multiGeneralMerge >= 0 && multiAwakeMerge > multiGeneralMerge, true, "多人响应必须先合并通用结算再合并觉醒结算")
assert.match(
    multiBattleSource,
    /const existingCharacterList = \[[\s\S]*?awakeMissionSettlement\.characterList[\s\S]*?reconcileAwakeUnlockCharacterListBestEffort\(\s*input\.playerId,\s*existingCharacterList,/,
    "多人 character_list 必须在 reconcile 前包含觉醒奖励与解锁更新",
)
assert.equal(multiTransactionCall > multiFactCall, true, "任务事实必须在事务体执行后统一提交")
assert.equal(multiActiveDelete > multiTransactionCall, true, "事务成功前不得清除多人 active quest 内存")
assert.equal(multiCoordinatorFinalize >= 0, true, "多人 finish 必须通过 coordinator 结束权威房间生命周期")
assert.equal(multiCoordinatorFinalize < multiTransactionCall, true, "Hub 网络操作不得在本地 SQLite 事务内执行")
assert.equal(multiBattleSource.includes("updateRoomState("), false, "HTTP 节点不得直接重置本地房间状态")
assert.match(
    multiBattleSource,
    /const finishCtx: FinishContext = \{[\s\S]*?isMultiHost: isRoomHost,[\s\S]*?\}/,
    "多人路由必须把 resolveIsRoomHost 的 true/false/undefined 原样写入 FinishContext",
)
assert.match(
    multiBattleSource,
    /const characterId = value\?\.id[\s\S]*?Number\.isSafeInteger\(characterId\)[\s\S]*?characterId > 0[\s\S]*?partyCharacterIdsArray\.push\(characterId\)/,
    "多人 finish 必须只收集 main/Sub 的有效正整数角色 ID",
)

recordMissionBattleFacts({
    ...baseContext,
    questAccomplished: true,
    isMulti: true,
    isMultiHost: undefined,
})
const unknownHostResult = calls.filter(([kind]) => kind === "result").at(-1)[2]
assert.deepEqual(unknownHostResult, {
    isMulti: true,
    questCategory: 1,
    isHost: undefined,
    accomplished: true,
    clearRank: 1,
    score: undefined,
    clearTime: 1000,
    skillUseCount: 5,
})

recordMissionBattleFacts({
    ...baseContext,
    questAccomplished: true,
    statistics: {
        ...baseContext.statistics,
        zones: [{ use_skill_count: 2 }, { use_skill_count: -1 }],
    },
})
assert.equal(
    calls.filter(([kind]) => kind === "result").at(-1)[2].skillUseCount,
    0,
    "任一 zone 技能统计非法时整场事实必须 fail closed",
)

console.log("mission battle facts tests passed")
