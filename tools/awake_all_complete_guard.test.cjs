// 觉醒 all-complete 家族的 row[19] 启动守卫回归:
// 运行时按 missionId-3/-2/-1 位减推导子任务集合;主数据 row[19] 是客户端
// 权威选择器,两者必须一致(2026-10-03 用户确认推导规则 = row[19] 权威)。
// 漂移时 validateAwakeBattleRuleSchemas 在首次觉醒战斗事实计算时抛错。

"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-row19-guard-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let restoreContentSnapshot = () => {}

function cleanup() {
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { validateAwakeBattleRuleSchemas } = require("../src/lib/mission/awake-battle-rules")

test("捆绑主数据的 all-complete 选择器与位减推导一致(守卫通过)", () => {
    assert.doesNotThrow(() => validateAwakeBattleRuleSchemas())
})

test("row[19] 与位减推导漂移时守卫必须失败", () => {
    const drifted = require("../assets/mission_char_awake.json")
    drifted["1110014"][0][19] = "1110011,1110012"
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { "mission_char_awake.json": drifted },
    })

    assert.throws(
        () => validateAwakeBattleRuleSchemas(),
        /field 19 expected "1110011,1110012,1110013"/,
        "row[19] 漂移必须在守卫处失败",
    )
})

test.after(() => {
    cleanup()
})
