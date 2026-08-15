require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
    MISSION_CATEGORIES,
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
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-30T04:00:00.000Z")), true)
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-31T03:59:59.000Z")), true)
assert.equal(isMissionDefinitionEnabledAt(regular, new Date("2099-12-31T03:59:59.001Z")), false)
assert.equal(isMissionDefinitionEnabledAt(
    { ...regular, enableStart: "2026-02-30 00:00:00", enableEnd: "2026-12-31 23:59:59" },
    new Date("2026-03-03T00:00:00.000Z"),
), false)
assert.deepEqual(MISSION_CATEGORIES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
assert.equal(Object.isFrozen(MISSION_CATEGORIES), true)
assert.throws(() => getMissionMasterDefinitions(99), /unsupported mission category: 99/)

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
    isMissionDefinitionEnabledAt(collect, new Date("2020-02-21T04:00:00.000Z"), 1),
    true,
)
assert.equal(
    isMissionDefinitionEnabledAt(collect, new Date("2020-02-21T04:00:00.000Z"), 2),
    false,
)

assert.equal(getMissionMasterDefinition(6, 1).eventId, 1)
assert.equal(getMissionMasterDefinition(7, 1).eventId, 1)
assert.equal(getMissionMasterDefinition(8, 1).eventId, 1)

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

const degreeClientProgressCases = [
    ["character_detail_zoom_illust_for_1min_count", 47000],
    ["character_detail_play_dot_sp_motion_count", 48000],
    ["home_tap_town_character_count", 49000],
    ["home_change_voice_count", 50000],
]
for (const [clientPattern, missionId] of degreeClientProgressCases) {
    assert.deepEqual(
        resolveClientProgressTargetsFromDefinitions(
            clientPattern,
            syntheticEvaluationTime,
            [getMissionMasterDefinition(5, missionId)],
        ),
        [{ category: 5, missionId }],
        `${clientPattern} 必须通过 Degree row selector 精确定位任务`,
    )
}
assert.deepEqual(
    resolveClientProgressTargetsFromDefinitions(
        "home_voice_change_count",
        syntheticEvaluationTime,
        degreeClientProgressCases.map(([, missionId]) => getMissionMasterDefinition(5, missionId)),
    ),
    [],
    "非 CN 1.8.1 客户端字段不得通过近似名称匹配",
)
const malformedDegreeRow = [...getMissionMasterDefinition(5, 47000).row]
malformedDegreeRow[3] = "40.0"
assert.deepEqual(
    resolveClientProgressTargetsFromDefinitions(
        "character_detail_zoom_illust_for_1min_count",
        syntheticEvaluationTime,
        [{
            ...getMissionMasterDefinition(5, 47000),
            row: malformedDegreeRow,
        }],
    ),
    [],
    "非法 Degree selector token 必须 fail closed",
)

console.log("mission master data tests passed")
