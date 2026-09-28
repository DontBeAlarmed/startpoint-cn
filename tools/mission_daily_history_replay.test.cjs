require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-daily-history-replay-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    restoreContentSnapshot()
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    incrementPlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const {
    getDailyCompletionDependencies,
} = require("../src/lib/mission/daily-completion")

initializeDatabase()
db = getDb()

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-daily-history-replay-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function completeDaily(playerId, missionId) {
    incrementPlayerCategoryMissionSync(playerId, 2, missionId, 100)
}

function progress(playerId, missionId) {
    return getPlayerCategoryMissionsSync(playerId, 2)[missionId]?.progress ?? 0
}

function settledMissionIds(playerId, evaluationTime) {
    return settleMissionCategories(playerId, [2], evaluationTime)
        .missionInfo.map(info => info.mission_id).sort((left, right) => left - right)
}

// ---------------------------------------------------------------------------
// getDailyCompletionDependencies unit semantics
// ---------------------------------------------------------------------------

function definitionWithRow17(patternType, deps) {
    return { pattern: "daily_quest_all_clear", row: { 2: String(patternType), 17: deps } }
}

assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "1,3,2,4")),
    [1, 3, 2, 4],
    "依赖必须保持 CDN 顺序",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "5,5,6")),
    [5, 6],
    "重复依赖必须去重且保持首次出现顺序",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "(None)")),
    [],
    "(None) 依赖集表示无 all-clear 计算",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "")),
    [],
    "空字符串依赖集 fail-closed",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "1,x,3")),
    [],
    "畸形依赖必须 fail-closed",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "1,0,3")),
    [],
    "非正整数依赖必须 fail-closed",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "1,-2,3")),
    [],
    "负数依赖必须 fail-closed",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(13, "1,2.5,3")),
    [],
    "非整数依赖必须 fail-closed",
)
assert.deepEqual(
    getDailyCompletionDependencies(definitionWithRow17(14, "1,3,2,4")),
    [],
    "只有 type 13 是 all-clear 依赖行",
)

// ---------------------------------------------------------------------------
// Four historical daily generations from assets/mission_daily.json
// windows are UTC+8 master-data columns converted to UTC instants
// ---------------------------------------------------------------------------

const GENERATIONS = [
    {
        allClear: 5,
        deps: [1, 3, 2, 4],
        start: new Date("2019-11-28T04:00:00.000Z"),
        end: new Date("2020-02-21T20:59:59.000Z"),
        sample: new Date("2020-01-15T04:00:00.000Z"),
        foreignDep: 6,
    },
    {
        allClear: 10,
        deps: [6, 8, 7, 9],
        start: new Date("2020-02-21T21:00:00.000Z"),
        end: new Date("2023-08-24T20:59:59.000Z"),
        sample: new Date("2021-06-15T04:00:00.000Z"),
        foreignDep: 1,
    },
    {
        allClear: 15,
        deps: [11, 13, 12, 14],
        start: new Date("2023-08-24T21:00:00.000Z"),
        end: new Date("2024-02-21T20:59:59.000Z"),
        sample: new Date("2023-12-15T04:00:00.000Z"),
        foreignDep: 16,
    },
    {
        allClear: 17,
        deps: [11, 13, 16, 14],
        start: new Date("2024-02-21T21:00:00.000Z"),
        end: new Date("2050-12-30T20:59:59.000Z"),
        sample: new Date("2024-08-14T12:00:00.000Z"),
        foreignDep: 12,
    },
]

for (const generation of GENERATIONS) {
    const { allClear, deps, sample, foreignDep } = generation

    const threeOfFour = createPlayer()
    for (const missionId of deps.slice(0, 3)) completeDaily(threeOfFour, missionId)
    const threeInfo = settledMissionIds(threeOfFour, sample)
    assert.deepEqual(
        threeInfo,
        [...deps.slice(0, 3)].sort((left, right) => left - right),
        `三代依赖完成时只应发依赖奖励（all-clear ${allClear}）`,
    )
    assert.equal(
        progress(threeOfFour, allClear),
        3,
        `三项完成时 all-clear ${allClear} 进度必须是 3`,
    )

    const fourth = deps[3]
    completeDaily(threeOfFour, fourth)
    const fourInfo = settledMissionIds(threeOfFour, sample)
    assert.equal(
        fourInfo.includes(allClear),
        true,
        `四项依赖全部完成后 all-clear ${allClear} 必须完成并出现在 mission_info`,
    )
    assert.equal(progress(threeOfFour, allClear), 4, `all-clear ${allClear} 完成进度必须是 4`)

    assert.deepEqual(
        settledMissionIds(threeOfFour, sample),
        [],
        `重复结算 all-clear ${allClear} 不得重复发奖`,
    )
    assert.equal(progress(threeOfFour, allClear), 4, `重复结算不得改变 all-clear ${allClear} 进度`)

    const isolated = createPlayer()
    completeDaily(isolated, foreignDep)
    const isolatedInfo = settledMissionIds(isolated, sample)
    assert.equal(
        isolatedInfo.includes(allClear),
        false,
        `非本代依赖 ${foreignDep} 完成不得触发 all-clear ${allClear}`,
    )
    assert.equal(
        progress(isolated, allClear),
        0,
        `非本代依赖 ${foreignDep} 不得计入 all-clear ${allClear} 进度`,
    )
}

// ---------------------------------------------------------------------------
// Window boundaries around the UTC+8 05:00 generation seams
// ---------------------------------------------------------------------------

for (const generation of GENERATIONS.slice(0, 3)) {
    const next = GENERATIONS[GENERATIONS.indexOf(generation) + 1]
    const playerId = createPlayer()
    for (const missionId of generation.deps) completeDaily(playerId, missionId)

    const beforeStart = new Date(generation.start.getTime() - 1)
    assert.deepEqual(
        settledMissionIds(playerId, beforeStart),
        [],
        `窗口前 1ms（${generation.start.toISOString()}）不得结算本代任务`,
    )
    assert.equal(
        progress(playerId, generation.allClear),
        0,
        "窗口前 all-clear 进度必须冻结为 0",
    )

    const atStart = settledMissionIds(playerId, generation.start)
    assert.equal(
        atStart.includes(generation.allClear),
        true,
        "起点整秒必须开放本代任务并完成 all-clear",
    )

    const playerIdEnd = createPlayer()
    for (const missionId of generation.deps) completeDaily(playerIdEnd, missionId)
    const atEnd = settledMissionIds(playerIdEnd, generation.end)
    assert.equal(
        atEnd.includes(generation.allClear),
        true,
        "终点整秒（04:59:59）本代任务仍然开放",
    )
    const afterEnd = new Date(generation.end.getTime() + 1)
    assert.deepEqual(
        settledMissionIds(playerIdEnd, afterEnd),
        [],
        `终点后 1ms 不得再结算本代任务（all-clear ${generation.allClear}）`,
    )
    assert.equal(
        progress(playerIdEnd, generation.allClear),
        4,
        "终点后 all-clear 进度必须保持终点值",
    )

    const seam = new Date(generation.end.getTime() + 999)
    assert.deepEqual(
        settledMissionIds(playerIdEnd, seam),
        [],
        "UTC+8 05:00 前的间隙（04:59:59.999）两代都不得结算",
    )
    const atNextStart = settledMissionIds(playerIdEnd, next.start)
    assert.equal(
        atNextStart.includes(next.allClear),
        false,
        "下一代起点不得用上一代玩家进度完成下一代 all-clear",
    )
}

console.log("mission daily history replay tests passed")
cleanup()
process.removeListener("exit", cleanup)
