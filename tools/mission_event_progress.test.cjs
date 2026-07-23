require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    EventComputer,
    getEventMissionCoverageReport,
} = require("../src/lib/mission/computer-event")
const { getComputer } = require("../src/lib/mission/registry")

function context(questProgress) {
    return {
        category: 3,
        playerId: 1,
        player: {},
        questProgress,
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
    }
}

const timeAttackQuest = {
    questId: 2001,
    finished: true,
    clearRank: 5,
    bestElapsedTimeMs: 60_000,
    leaderCharacterId: undefined,
    multiClearCount: undefined,
}
assert.equal(
    EventComputer.compute(2008342, context({ 11: [timeAttackQuest] }), 0),
    0,
    "50 秒限时任务不能由 60 秒通关记录完成",
)
assert.equal(
    EventComputer.compute(2008342, context({
        11: [{ ...timeAttackQuest, bestElapsedTimeMs: 49_000 }],
    }), 0),
    1,
    "50 秒限时任务应接受 49 秒最佳记录",
)

assert.equal(EventComputer.compute(1303, context({
    13: [
        { ...timeAttackQuest, questId: 1001 },
        { ...timeAttackQuest, questId: 1002, finished: false },
    ],
}), 0), 1)

assert.equal(EventComputer.compute(1400, context({
    2: [{ ...timeAttackQuest, questId: 1001001, multiClearCount: 7 }],
}), 0), 7)

const coverage = getEventMissionCoverageReport(new Date("2024-08-14T12:00:00.000Z"))
assert.deepEqual(coverage.countModes, { single: 396, multi: 1679, finish: 230 })
assert.equal(coverage.total, 2512)
assert.equal(coverage.mapped, 2305)
assert.equal(coverage.safeAutoSettlement, 0)
assert.equal(coverage.unsupported, 207)
assert.equal(coverage.activeUnsupported, 0)
assert.equal(coverage.unsupportedPatterns.includes("startdash_day1_1"), true)
assert.equal(getComputer(3).name, "Fallback", "旧活动 map 未完成规则化前不得驱动客户端进度或发奖")

console.log("mission event progress tests passed")
