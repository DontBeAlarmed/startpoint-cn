require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const corePath = path.resolve(__dirname, "../src/lib/mission/active-core.ts")
assert.equal(fs.existsSync(corePath), true, "Active Mission 纯逻辑核心模块必须存在")

const {
    getActiveMissionEventReleasePhase,
    isActiveMissionAvailable,
    isActiveMissionClaimable,
    parseCnMasterDateTime,
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    settleActiveMissionProgress,
} = require(corePath)
assert.equal(typeof parseCnMasterDateTime, "function", "核心模块必须导出国服主表时间解析函数")

const {
    getActiveMissionEventMasterDefinitions,
    getActiveMissionMasterDefinitions,
} = require("../src/lib/mission/active-master-data")
const { getMissionRewardStageDefinition } = require("../src/lib/mission/rewards")
const { validateMissionRewardClaims } = require("../src/lib/mission/claims")
const { filterToActiveMissions } = require("../src/lib/mission/filter")

const rewardRow = []
rewardRow[3] = "99"
rewardRow[4] = "(None)"
rewardRow[7] = "1"
rewardRow[8] = "7"
rewardRow[9] = "101"

const tables = {
    "mission_active.json": { 99001: [missionRow({
        eventId: 99,
        stringId: "repository_active_mission",
        pattern: 0,
    })] },
    "mission_active_event.json": { 99: [eventRow({
        kind: 0,
        start: "2020-01-01 00:00:00",
    })] },
    "mission_active_reward.json": { 99001: { 1: [rewardRow] } },
}
const repository = {
    info: () => ({
        source: "release",
        assetVersion: "test",
        generatorVersion: 1,
        releaseDigest: "active-mission-test",
    }),
    table: tableName => tables[tableName],
}

assert.deepEqual(
    getActiveMissionMasterDefinitions(repository).map(definition => definition.missionId),
    [99001],
    "显式 repository 必须覆盖 bundled Active Mission 表",
)
assert.deepEqual(
    getActiveMissionEventMasterDefinitions(repository).map(definition => definition.eventId),
    [99],
)
assert.equal(
    getMissionRewardStageDefinition(99001, 1, repository)?.targetProgress,
    99,
    "显式 repository 必须覆盖 bundled Active Mission 奖励表",
)
assert.deepEqual(
    filterToActiveMissions({ 99001: { progress: 1 }, 20001: { progress: 1 } }, repository),
    { 99001: { progress: 1 } },
    "load 白名单必须跟随当前 repository，不能保留 bundled 任务 ID",
)

function missionRow({ eventId, phase, stringId, pattern = 0, need, show, start, end }) {
    const row = []
    row[0] = String(eventId)
    row[1] = phase === undefined ? "(None)" : String(phase)
    row[3] = stringId
    row[29] = String(pattern)
    row[56] = need ? String(need.missionId) : "(None)"
    row[57] = need ? String(need.stage) : ""
    row[58] = show ? String(show.missionId) : "(None)"
    row[59] = show ? String(show.stage) : ""
    row[60] = start ?? "(None)"
    row[61] = end ?? "(None)"
    return row
}

function eventRow({ kind = 0, maxPhase, start, end, needQuestId }) {
    const row = []
    row[2] = String(kind)
    row[3] = maxPhase === undefined ? "(None)" : String(maxPhase)
    row[14] = start
    row[15] = end ?? "(None)"
    row[22] = needQuestId === undefined ? "(None)" : String(needQuestId)
    return row
}

function stageRow(targetProgress, targetClearSeconds) {
    const row = []
    row[3] = String(targetProgress)
    row[4] = targetClearSeconds === undefined ? "(None)" : String(targetClearSeconds)
    row[7] = "1"
    row[8] = "1"
    row[9] = "101"
    return row
}

const releaseTables = {
    "mission_active.json": {
        9001: [missionRow({
            eventId: 90,
            phase: 1,
            stringId: "phase_one_a",
            start: "2024-08-14 20:00:00",
            end: "2024-08-14 21:00:00",
        })],
        9002: [missionRow({
            eventId: 90,
            phase: 1,
            stringId: "phase_one_b",
            start: "2024-08-14 20:00:00",
            end: "2024-08-14 21:00:00",
        })],
        9003: [missionRow({
            eventId: 90,
            phase: 2,
            stringId: "phase_two",
            need: { missionId: 9001, stage: 1 },
            show: { missionId: 9002, stage: 1 },
            start: "2024-08-14 20:00:00",
            end: "2024-08-14 21:00:00",
        })],
        9004: [missionRow({
            eventId: 90,
            phase: 1,
            stringId: "claimed_but_incomplete_dependency",
            need: { missionId: 9001, stage: 2 },
            show: { missionId: 9002, stage: 1 },
            start: "2024-08-14 20:00:00",
            end: "2024-08-14 21:00:00",
        })],
        9101: [missionRow({
            eventId: 91,
            phase: 1,
            stringId: "timed_clear",
            start: "2024-08-14 20:00:00",
        })],
    },
    "mission_active_event.json": {
        90: [eventRow({
            maxPhase: 2,
            start: "2024-08-14 20:00:00",
            end: "2024-08-14 21:00:00",
        })],
        91: [eventRow({ maxPhase: 1, start: "2024-08-14 20:00:00" })],
    },
    "mission_active_reward.json": {
        9001: { 1: [stageRow(10)], 2: [stageRow(20)] },
        9002: { 1: [stageRow(5)] },
        9003: { 1: [stageRow(1)] },
        9004: { 1: [stageRow(1)] },
        9101: { 1: [stageRow(1, 30)] },
    },
}
const releaseRepository = {
    info: repository.info,
    table: tableName => releaseTables[tableName],
}

assert.equal(
    parseCnMasterDateTime("2024-08-14 21:00:00"),
    Date.parse("2024-08-14T13:00:00.000Z"),
    "国服客户端沿用 JST 符号名，但主表日期实际按 UTC+8 转为 UTC",
)
assert.throws(() => parseCnMasterDateTime("2024-02-30 00:00:00"), /CN master/i)

const parsedMission = parseActiveMissionDefinition(9003, releaseTables["mission_active.json"][9003][0])
assert.deepEqual(
    {
        eventId: parsedMission.eventId,
        phase: parsedMission.phase,
        stringId: parsedMission.stringId,
        need: parsedMission.need,
        show: parsedMission.show,
    },
    {
        eventId: 90,
        phase: 2,
        stringId: "phase_two",
        need: { missionId: 9001, stage: 1 },
        show: { missionId: 9002, stage: 1 },
    },
)
const parsedEvent = parseActiveMissionEventDefinition(90, releaseTables["mission_active_event.json"][90][0])
assert.equal(parsedEvent.kind, 0)
assert.equal(parsedEvent.maxPhase, 2)

const exactEnd = Date.parse("2024-08-14T13:00:00.000Z")
const emptyContext = {
    repository: releaseRepository,
    now: exactEnd,
    activeMissions: {},
    questProgress: {},
}
assert.equal(isActiveMissionAvailable(9001, emptyContext), true, "事件和任务结束边界必须包含等号")
assert.equal(isActiveMissionAvailable(9001, { ...emptyContext, now: exactEnd + 1 }), false)

const incompletePhaseState = {
    9001: { progress: 10, stages: {} },
    9002: { progress: 5, stages: {} },
}
assert.equal(getActiveMissionEventReleasePhase(90, incompletePhaseState, releaseRepository), 1)
const completePhaseState = {
    9001: { progress: 20, stages: { 1: false, 2: false } },
    9002: { progress: 5, stages: { 1: false } },
    9004: { progress: 1, stages: { 1: false } },
}
assert.equal(
    getActiveMissionEventReleasePhase(90, completePhaseState, releaseRepository),
    2,
    "phase 完成只看当前奖励阶段阈值，不要求领取",
)
assert.equal(isActiveMissionAvailable(9003, {
    ...emptyContext,
    activeMissions: completePhaseState,
}), false, "need/show 阶段未领取时必须拒绝")
assert.equal(isActiveMissionAvailable(9004, {
    ...emptyContext,
    activeMissions: {
        9001: { progress: 10, stages: { 2: true } },
        9002: { progress: 5, stages: { 1: true } },
    },
}), false, "need/show 阶段即使标记已领取，也必须满足对应进度阈值")
assert.equal(isActiveMissionAvailable(9003, {
    ...emptyContext,
    activeMissions: {
        9001: { progress: 20, stages: { 1: true, 2: false } },
        9002: { progress: 5, stages: { 1: true } },
        9004: { progress: 1, stages: { 1: false } },
    },
}), true, "phase 已释放且 need/show 阶段已领取时必须允许")

const settled = settleActiveMissionProgress(
    9001,
    { progress: 0, stages: {} },
    10,
    { repository: releaseRepository },
)
assert.deepEqual(settled.state, { progress: 10, stages: { 1: false } })
assert.deepEqual(settled.delta, {
    mission_id: 9001,
    progress_value: 10,
    stages: [{ stage: 1, received: false }],
})
assert.equal(
    settleActiveMissionProgress(9001, settled.state, 10, { repository: releaseRepository }).delta,
    null,
    "相同 absolute progress 重复结算必须幂等",
)
assert.equal(
    settleActiveMissionProgress(9001, settled.state, 5, { repository: releaseRepository }).delta,
    null,
    "权威事实短暂降低时不得让既有任务进度倒退",
)
assert.equal(
    settleActiveMissionProgress(
        9001,
        { progress: 0, stages: { 1: true } },
        10,
        { repository: releaseRepository },
    ).state.stages[1],
    true,
    "已领取阶段不得回退为 false",
)
assert.deepEqual(
    settleActiveMissionProgress(9101, { progress: 0, stages: {} }, 1, {
        repository: releaseRepository,
    }).state.stages,
    {},
    "限时任务缺少 clearSeconds 时必须 fail closed",
)
assert.deepEqual(
    settleActiveMissionProgress(9101, { progress: 0, stages: {} }, 1, {
        repository: releaseRepository,
        clearSeconds: 31,
    }).state.stages,
    {},
)
assert.equal(
    settleActiveMissionProgress(9101, { progress: 0, stages: {} }, 1, {
        repository: releaseRepository,
        clearSeconds: 30,
    }).state.stages[1],
    false,
)

const bundledTables = {
    "mission_active.json": require("../assets/mission_active.json"),
    "mission_active_event.json": require("../assets/mission_active_event.json"),
    "mission_active_reward.json": require("../assets/mission_active_reward.json"),
}
const bundledRepository = {
    info: repository.info,
    table: tableName => bundledTables[tableName],
}
const serverNow = Date.parse("2024-08-14T12:00:00.000Z")
const bundledContext = {
    repository: bundledRepository,
    now: serverNow,
    activeMissions: {},
    questProgress: {},
}
assert.equal(isActiveMissionAvailable(21010, bundledContext), false, "event 3 在当前服务器时间必须过期")
assert.equal(isActiveMissionAvailable(20001, bundledContext), false, "event 2 前置关卡未通关必须拒绝")
assert.equal(isActiveMissionAvailable(20001, {
    ...bundledContext,
    questProgress: { 1: [{ questId: 1008004, finished: true }] },
}), true, "event 2 前置关卡 finished=true 后必须允许")

const contentsGuideClaimState = { 20001: { progress: 1, stages: { 1: false } } }
assert.deepEqual(
    validateMissionRewardClaims(
        contentsGuideClaimState,
        [{ mission_id: 20001, stages: [1] }],
        {
            repository: bundledRepository,
            now: serverNow,
            questProgress: {},
        },
    ),
    { ok: false, message: "Active mission is not available." },
    "领奖必须复用活动和前置关卡可用性校验",
)
assert.equal(
    validateMissionRewardClaims(
        contentsGuideClaimState,
        [{ mission_id: 20001, stages: [1] }],
        {
            repository: bundledRepository,
            now: serverNow,
            questProgress: { 1: [{ questId: 1008004, finished: true }] },
        },
    ).ok,
    true,
)
assert.deepEqual(
    validateMissionRewardClaims(
        { 21010: { progress: 1, stages: { 1: false } } },
        [{ mission_id: 21010, stages: [1] }],
        {
            repository: bundledRepository,
            now: serverNow,
            questProgress: {},
        },
    ),
    { ok: false, message: "Active mission is not available." },
    "已过期 event 3 不得仅凭数据库进度领奖",
)

const realIncentiveClaimTime = Date.parse("2022-12-20T00:00:00.000Z")
assert.equal(isActiveMissionAvailable(21010, {
    ...bundledContext,
    now: realIncentiveClaimTime,
}), false, "Real Incentive 完成期限结束后不得继续推进任务")
assert.equal(isActiveMissionClaimable(21010, {
    ...bundledContext,
    now: realIncentiveClaimTime,
}), true, "Real Incentive 在展示/领奖期内必须允许领取已完成阶段")
assert.equal(
    validateMissionRewardClaims(
        { 21010: { progress: 1, stages: { 1: false } } },
        [{ mission_id: 21010, stages: [1] }],
        {
            repository: bundledRepository,
            now: realIncentiveClaimTime,
            questProgress: {},
        },
    ).ok,
    true,
    "领奖校验不得把任务完成期限误当成领奖期限",
)
assert.equal(isActiveMissionClaimable(21010, {
    ...bundledContext,
    now: Date.parse("2023-01-06T00:00:00.000Z"),
}), false, "展示/事件期限结束后必须拒绝领奖")

for (const eventId of [1, 150]) {
    const definition = getActiveMissionEventMasterDefinitions(bundledRepository)
        .find(event => event.eventId === eventId)
    assert.equal(parseActiveMissionEventDefinition(eventId, definition.row).endTime, undefined)
}

console.log("mission active core tests passed")
