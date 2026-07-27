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
    trackPartyCoClears: ctx => calls.push(["party", ctx.questId]),
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

const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")

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

recordMissionBattleFacts({ ...baseContext, questAccomplished: false })
assert.deepEqual(calls, [["result", 1, {
    isMulti: false,
    questCategory: 1,
    isHost: undefined,
    accomplished: false,
    clearRank: 1,
    score: undefined,
    clearTime: 1000,
    skillUseCount: 0,
}]])
assert.equal(calls.some(([kind]) => kind === "party"), false, "failed settlement must not call direct awake tracker")

recordMissionBattleFacts({ ...baseContext, questAccomplished: true, isMulti: true, isMultiHost: true })
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
    ["degree-stats", 1001],
    ["daily", 1001],
    ["event", 1001],
    ["degree", 1001],
    ["pass", 1001],
    ["active-specific", 1001],
    ["active-conditional", 1001],
    ["multi", 1, 1, 1001],
    ["character", 1001],
    ["leader-powerflip", 1001],
    ["party", 1001],
    ["powerflip", 1001],
])

const singleBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const singleTransactionStart = singleBattleSource.indexOf("const executeFinishWrites = () => {")
const singleEvaluationTime = singleBattleSource.indexOf(
    "const settlementTime = new Date(getServerTime() * 1000)",
    singleTransactionStart,
)
const singleFactCall = singleBattleSource.indexOf(
    "recordMissionBattleFacts(finishCtx, settlementTime)",
    singleEvaluationTime,
)
const singleSettlementTime = singleBattleSource.indexOf(
    "BATTLE_SETTLEMENT_CATEGORIES,\n                settlementTime,",
    singleFactCall,
)
assert.equal(singleEvaluationTime > singleTransactionStart, true, "单人 finish 必须在事务体内固定任务时间")
assert.equal(singleFactCall > singleEvaluationTime, true, "单人任务事实必须使用事务时间")
assert.equal(singleSettlementTime > singleFactCall, true, "单人任务结算必须复用事实记录的时间")
assert.equal(
    singleBattleSource.includes("const finishWrites = getDb().transaction(executeFinishWrites)()"),
    true,
    "所有单人同步结算写入必须共享事务",
)

const multiBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/http/battle.ts"),
    "utf8",
)
const multiTransactionStart = multiBattleSource.indexOf("const executeFinishWrites = () => {")
const multiEvaluationTime = multiBattleSource.indexOf(
    "const settlementTime = new Date(getServerTime() * 1000)",
    multiTransactionStart,
)
const multiFactCall = multiBattleSource.indexOf(
    "recordMissionBattleFacts(finishCtx, settlementTime)",
    multiEvaluationTime,
)
const multiSettlementTime = multiBattleSource.indexOf(
    "BATTLE_SETTLEMENT_CATEGORIES,\n                settlementTime,",
    multiFactCall,
)
const multiTransactionCall = multiBattleSource.indexOf("getDb().transaction(executeFinishWrites)()")
const multiActiveDelete = multiBattleSource.indexOf("delete activeQuests[playerId]", multiTransactionCall)
const multiRoomReset = multiBattleSource.indexOf("updateRoomState(room.room_number, 1)", multiTransactionCall)
assert.equal(multiTransactionStart >= 0, true, "多人 finish 必须定义同步结算事务体")
assert.equal(multiEvaluationTime > multiTransactionStart, true, "多人 finish 必须在事务体内固定任务时间")
assert.equal(multiFactCall > multiTransactionStart, true)
assert.equal(multiSettlementTime > multiFactCall, true, "多人任务结算必须复用事实记录的时间")
assert.equal(multiTransactionCall > multiFactCall, true, "任务事实必须在事务体执行后统一提交")
assert.equal(multiActiveDelete > multiTransactionCall, true, "事务成功前不得清除多人 active quest 内存")
assert.equal(multiRoomReset > multiTransactionCall, true, "事务成功前不得重置多人房间状态")
assert.match(
    multiBattleSource,
    /const finishCtx: FinishContext = \{[\s\S]*?isMultiHost: isRoomHost,[\s\S]*?\}/,
    "多人路由必须把 resolveIsRoomHost 的 true/false/undefined 原样写入 FinishContext",
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
