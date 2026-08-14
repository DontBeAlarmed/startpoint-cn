require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
} = require("../src/lib/mission/master-data")
const {
    getMissionIdsByCategory,
} = require("../src/lib/mission/stages")
const {
    getCategoryMissionRewardStageDefinition,
} = require("../src/lib/mission/rewards")
const { getComputer } = require("../src/lib/mission/registry")
const { getPassCardRewardDefinition } = require("../src/lib/pass-card")
const passCardRewards = require("../assets/pass_card_reward.json")

const missionTypesSource = fs.readFileSync(path.resolve(__dirname, "../src/lib/mission/types.ts"), "utf8")
const passComputerSource = fs.readFileSync(path.resolve(__dirname, "../src/lib/mission/pass.ts"), "utf8")
assert.match(
    missionTypesSource,
    /buildContext\s*\(\s*playerId\s*:\s*number\s*,\s*category\s*:\s*number\s*,\s*evaluationTime\s*:\s*Date(?:\s*,\s*missionIds\s*\?\s*:\s*readonly\s+number\[\])?\s*,?\s*\)\s*:\s*CategoryContext/,
    "MissionComputer 必须要求调用方提供统一的评估时间",
)
assert.doesNotMatch(
    passComputerSource,
    /evaluationTime\s*=\s*new Date\(\)/,
    "PassComputer 不得回退到系统时间",
)

assert.equal(getMissionMasterDefinitions(6).length, 76)
assert.equal(getMissionMasterDefinitions(7).length, 76)
assert.equal(getMissionMasterDefinitions(8).length, 115)

const daily = getMissionMasterDefinition(6, 1)
assert.equal(daily.eventId, 1)
assert.equal(daily.pattern, "battle_pass_single_battle_daily_01")
assert.equal(daily.patternType, 14)
assert.equal(daily.enableStart, "2024-06-01 05:00:00")
assert.equal(daily.enableEnd, "2024-07-01 04:59:59")

const week = getMissionMasterDefinition(7, 1)
assert.equal(week.eventId, 1)
assert.equal(week.pattern, "battle_pass_stamina_week_01")
assert.equal(week.patternType, 39)

const event = getMissionMasterDefinition(8, 1)
assert.equal(event.eventId, 1)
assert.equal(event.pattern, "battle_pass_login_event_01")
assert.equal(event.patternType, 0)

assert.equal(getMissionIdsByCategory(6).length, 76)
assert.equal(getMissionIdsByCategory(7).length, 76)
assert.equal(getMissionIdsByCategory(8).length, 115)

assert.deepEqual(getCategoryMissionRewardStageDefinition(6, 1, 1), {
    missionRewardId: 1001,
    targetProgress: 1,
    rewards: [{ kind: 7, amount: 50 }],
})
assert.deepEqual(getCategoryMissionRewardStageDefinition(7, 1, 1), {
    missionRewardId: 1001,
    targetProgress: 500,
    rewards: [{ kind: 7, amount: 80 }],
})
assert.deepEqual(getCategoryMissionRewardStageDefinition(8, 1, 1), {
    missionRewardId: 1001,
    targetProgress: 1,
    rewards: [{ kind: 7, amount: 100 }],
})
assert.deepEqual(getPassCardRewardDefinition(150), {
    rewardId: 150,
    eventId: 3,
    level: 30,
    reward1: { kind: 6, amount: 0, degreeId: 80019 },
    reward2: { kind: 6, amount: 0, degreeId: 80020 },
})
for (const rewardId of Object.keys(passCardRewards).map(Number)) {
    assert.notEqual(getPassCardRewardDefinition(rewardId), undefined)
}

assert.equal(
    isMissionDefinitionEnabledAt(daily, new Date("2024-05-31T20:59:59.999Z")),
    false,
)
assert.equal(
    isMissionDefinitionEnabledAt(daily, new Date("2024-05-31T21:00:00.000Z")),
    true,
    "Pass 请求不携带 event_id，必须按主数据开放期选择当前活动",
)
assert.equal(
    isMissionDefinitionEnabledAt(daily, new Date("2024-07-31T20:00:00.000Z")),
    false,
)

const passDailyComputer = getComputer(6)
assert.equal(passDailyComputer.name, "Pass")
const dailyContext = {
    category: 6,
    playerId: 1,
    player: {
        totalDashes: 14,
        totalStaminaUsed: 40,
    },
    questProgress: {},
    totalQuestClears: 0,
    totalStories: 0,
    rankCounts: {},
    battleCounters: {
        singleClearCount: 8,
        multiClearCount: 6,
    },
    snapshot: {
        singleClearCount: 5,
        multiClearCount: 2,
        dashCount: 10,
        staminaUsed: 25,
    },
}
assert.equal(passDailyComputer.compute(1, dailyContext, 0), 3)
assert.equal(passDailyComputer.compute(2, dailyContext, 0), 4)
assert.equal(passDailyComputer.compute(3, dailyContext, 0), 4)
assert.equal(passDailyComputer.compute(4, dailyContext, 0), 15)

const passWeekComputer = getComputer(7)
const weekContext = {
    ...dailyContext,
    category: 7,
}
assert.equal(passWeekComputer.compute(1, weekContext, 0), 15)
assert.equal(passWeekComputer.compute(2, weekContext, 0), 4)
assert.equal(passWeekComputer.compute(3, weekContext, 7), 7)
assert.equal(passWeekComputer.compute(4, weekContext, 9), 9)

const passEventComputer = getComputer(8)
const eventContext = {
    ...dailyContext,
    category: 8,
    passEventLoginProgress: { 1: 3 },
}
assert.equal(passEventComputer.compute(1, eventContext, 0), 3)

console.log("mission pass tests passed")
