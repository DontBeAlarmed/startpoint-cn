"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-gacha-draw-facts-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

function cleanup() {
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { recordDailyGachaDrawFacts } = require("../src/lib/mission/gacha-draw-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-gacha-draw-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

// 210104 【黄金周】抽取1次角色扭蛋: 2022-09-30 05:00 .. 2022-10-07 04:59 CN.
// 210109 【黄金周最后一天】: 2022-10-07 05:00 .. 2022-10-08 04:59 CN.
const inWindow = new Date("2022-10-01T12:00:00.000Z")
const lastDayWindow = new Date("2022-10-07T12:00:00.000Z")
const beforeWindow = new Date("2022-09-29T00:00:00.000Z")

function dailyProgress(missionId) {
    return getPlayerCategoryMissionsSync(playerId, 2)[missionId]?.progress ?? 0
}

assert.deepEqual(recordDailyGachaDrawFacts(playerId, 1, inWindow), [210104])
assert.equal(dailyProgress(210104), 1)
assert.deepEqual(recordDailyGachaDrawFacts(playerId, 1, lastDayWindow), [210109])
assert.equal(dailyProgress(210109), 1)
assert.deepEqual(recordDailyGachaDrawFacts(playerId, 0, inWindow), [], "零次抽取是 no-op")
assert.deepEqual(recordDailyGachaDrawFacts(playerId, 1, beforeWindow), [], "记账必须自带开放期门")
assert.equal(dailyProgress(210104), 1)

const settlement = settleMissionCategories(playerId, [2], inWindow)
assert.deepEqual(
    settlement.missionInfo.map(info => info.mission_id).includes(210104),
    true,
    "黄金周抽卡任务达到 1 次后必须结算奖励",
)

console.log("mission gacha draw facts tests passed")
