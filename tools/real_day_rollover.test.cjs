// 主日切的真实业务日回归(dailyResetPlayerDataSync):
// 跨天口径 = 周期刷新桶走【真实业务日】(UTC+8 05:00 桶,真实墙钟),
// 跳转服务器时间(虚拟钟)不推进日常周期;真实日缺口超过一天也只按
// 一天计(时间可调服务的兼容性钳制,不补计缺席天数);开放/领取窗口
// 仍走虚拟时间(lastLoginTime 保持虚拟语义)。
// 场景:①同真实天跳虚拟时间不重置;②真实日 +1 单次重置;③缺口 3 天
// 钳制 1 次;④真实周边界重置周常。

"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "real-day-rollover-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { dailyResetPlayerDataSync, getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")

initializeDatabase()
db = getDb()

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `real-day-rollover-${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function totalLoginDays(playerId) {
    return getPlayerSync(playerId).totalLoginDays ?? 0
}

function realBusinessDayMarker(playerId) {
    return db.prepare(`
        SELECT last_daily_reset_real_business_day
        FROM players WHERE id = ?
    `).get(playerId)?.last_daily_reset_real_business_day ?? null
}

test("同真实天跳转虚拟时间不得重复日切", () => {
    const playerId = createPlayer("same-real-day-jump")
    // 首次标记写入(新玩家/导入档/迁移)只落标记不触发日切:
    // 避免同真实日双计登录天;周期从下一个真实业务日开始
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-14T12:00:00.000Z"),
        new Date("2024-08-14T12:00:00.000Z"),
    ), false, "首次标记写入不得触发日切")
    assert.equal(realBusinessDayMarker(playerId), "2024-08-14", "标记必须写入当前真实业务日")
    const afterFirst = totalLoginDays(playerId)

    // 同一真实天内,虚拟时间向前跳 3 天:不重置、天数不涨
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-17T12:00:00.000Z"),
        new Date("2024-08-14T13:00:00.000Z"),
    ), false, "虚拟时间跳动不得推进日常周期")
    assert.equal(totalLoginDays(playerId), afterFirst, "同真实天天数不得推进")

    // 向后跳虚拟时间同样不重置,且 lastLoginTime 保持虚拟语义
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-10T12:00:00.000Z"),
        new Date("2024-08-14T14:00:00.000Z"),
    ), false)
    assert.equal(
        getPlayerSync(playerId).lastLoginTime.getTime(),
        new Date("2024-08-10T12:00:00.000Z").getTime(),
        "lastLoginTime 必须保持虚拟语义",
    )
})

test("真实日 +1 恰好单次重置,重复 load 不再加", () => {
    const playerId = createPlayer("single-cross")
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-14T12:00:00.000Z"),
        new Date("2024-08-14T12:00:00.000Z"),
    ), false, "首次标记写入不触发日切")
    const afterFirst = totalLoginDays(playerId)

    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-15T12:00:00.000Z"),
        new Date("2024-08-15T12:00:00.000Z"),
    ), true, "真实日推进必须触发日切")
    assert.equal(totalLoginDays(playerId), afterFirst + 1, "天数每次只加 1")

    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-15T18:00:00.000Z"),
        new Date("2024-08-15T18:00:00.000Z"),
    ), false, "同一真实日重复 load 不得再次重置")
    assert.equal(totalLoginDays(playerId), afterFirst + 1)
})

test("真实日缺口 3 天钳制为 1 次(不补计缺席天数)", () => {
    const playerId = createPlayer("gap-clamp")
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-14T12:00:00.000Z"),
        new Date("2024-08-14T12:00:00.000Z"),
    ), false, "首次标记写入不触发日切")
    const afterFirst = totalLoginDays(playerId)
    assert.equal(realBusinessDayMarker(playerId), "2024-08-14")

    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-17T12:00:00.000Z"),
        new Date("2024-08-17T12:00:00.000Z"),
    ), true, "真实日推进触发日切")
    assert.equal(totalLoginDays(playerId), afterFirst + 1, "缺口 3 天只计 1 天")
    assert.equal(realBusinessDayMarker(playerId), "2024-08-17", "标记必须推进到当前真实业务日")
})

test("真实周边界重置周常", () => {
    const playerId = createPlayer("real-week-cross")
    // 2024-08-18(周日)首次标记写入;2024-08-19(周一)05:00+8 为真实周边界
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-18T12:00:00.000Z"),
        new Date("2024-08-18T12:00:00.000Z"),
    ), false, "首次标记写入不触发日切")
    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-18T20:00:00.000Z"),
        new Date("2024-08-18T20:00:00.000Z"),
    ), false)

    assert.equal(dailyResetPlayerDataSync(
        getPlayerSync(playerId),
        new Date("2024-08-19T12:00:00.000Z"),
        new Date("2024-08-19T12:00:00.000Z"),
    ), true, "真实周边界必须触发日切(含周重置)")
    assert.equal(realBusinessDayMarker(playerId), "2024-08-19")
})

test.after(() => {
    cleanup()
})
