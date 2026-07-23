require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    getMissionMasterDefinition,
    isMissionDefinitionEnabledAt,
} = require("../src/lib/mission/master-data")
const {
    resolveClientProgressTargetsFromDefinitions,
} = require("../src/lib/mission/client-progress")

const collect = getMissionMasterDefinition(4, 1500)
assert.equal(collect.eventId, 1)
assert.equal(collect.pattern, "collect_item_event_001_01")
assert.equal(collect.enableStart, "2020-02-21 12:00:00")
assert.equal(collect.enableEnd, "2020-03-05 11:59:59")

const degree = getMissionMasterDefinition(5, 1000)
assert.equal(degree.pattern, "degree_player_rank_growth_1")
assert.equal(degree.enableStart, "2020-07-06 12:00:00")
assert.equal(degree.enableEnd, undefined)

const awake = getMissionMasterDefinition(9, 11)
assert.equal(awake.pattern, "alk_awake_mission_1")
assert.equal(awake.enableStart, "2024-07-18 12:00:00")
assert.equal(awake.enableEnd, "2099-04-13 11:59:59")

const regular = getMissionMasterDefinition(1, 107)
assert.equal(regular.pattern, "twitter_check_mission_001")
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-30T03:00:00.000Z")), true)
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-31T02:59:59.000Z")), true)
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-31T02:59:59.001Z")), false)

const daily = getMissionMasterDefinition(2, 1)
assert.equal(daily.pattern, "single_battle_play")
assert.equal(daily.enableStart, "2019-11-28 12:00:00")
assert.equal(daily.enableEnd, "2020-02-22 04:59:59")

const event = getMissionMasterDefinition(3, 1200)
assert.equal(event.pattern, "startdash_day1_1")
assert.equal(event.enableStart, "2019-11-27 12:00:00")
assert.equal(event.enableEnd, "2019-12-16 11:59:59")

const weekly = getMissionMasterDefinition(10, 1)
assert.equal(weekly.pattern, "weekly_mission_1")
assert.equal(weekly.enableStart, "2024-07-18 12:00:00")
assert.equal(weekly.enableEnd, "2050-05-31 12:00:00")

assert.equal(
    isMissionDefinitionEnabledAt(collect, new Date("2020-02-21T03:00:00.000Z"), 1),
    true,
)
assert.equal(
    isMissionDefinitionEnabledAt(collect, new Date("2020-02-21T03:00:00.000Z"), 2),
    false,
)

assert.throws(() => getMissionMasterDefinition(6, 1), /unsupported mission category/)

const syntheticEvaluationTime = new Date("2024-08-14T12:00:00.000Z")
const syntheticDefinitions = [
    { category: 1, missionId: 1, pattern: "twitter_check_regular", row: [] },
    { category: 4, missionId: 2, pattern: "twitter_check_event_a", eventId: 10, row: [] },
    { category: 4, missionId: 3, pattern: "twitter_check_event_b", eventId: 11, row: [] },
]
assert.deepEqual(
    resolveClientProgressTargetsFromDefinitions(
        "twitter_check",
        syntheticEvaluationTime,
        syntheticDefinitions,
    ),
    [{ category: 1, missionId: 1 }],
    "没有 event_id 的静默请求不得写入任何活动作用域任务",
)

console.log("mission master data tests passed")
