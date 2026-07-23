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

const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")

const baseContext = {
    playerId: 1,
    questCategory: 1,
    questId: 1001,
    clearTime: 1000,
    clearRank: 1,
    party: { characters: [], unison_characters: [] },
    statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] } },
    player: {},
    questPreviouslyCompleted: false,
    questProgress: null,
}

recordMissionBattleFacts({ ...baseContext, questAccomplished: false })
assert.deepEqual(calls, [])

recordMissionBattleFacts({ ...baseContext, questAccomplished: true, isMulti: true })
assert.deepEqual(calls, [
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
const multiFactCall = multiBattleSource.indexOf("recordMissionBattleFacts(finishCtx)")
const multiTransactionCall = multiBattleSource.indexOf("getDb().transaction(executeFinishWrites)()")
const multiActiveDelete = multiBattleSource.indexOf("delete activeQuests[playerId]", multiTransactionCall)
const multiRoomReset = multiBattleSource.indexOf("updateRoomState(room.room_number, 1)", multiTransactionCall)
assert.equal(multiTransactionStart >= 0, true, "多人 finish 必须定义同步结算事务体")
assert.equal(multiFactCall > multiTransactionStart, true)
assert.equal(multiTransactionCall > multiFactCall, true, "任务事实必须在事务体执行后统一提交")
assert.equal(multiActiveDelete > multiTransactionCall, true, "事务成功前不得清除多人 active quest 内存")
assert.equal(multiRoomReset > multiTransactionCall, true, "事务成功前不得重置多人房间状态")

console.log("mission battle facts tests passed")
