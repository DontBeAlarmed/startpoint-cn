"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const previousDataDirectory = process.env.DATA_DIR
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-ex-"))
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")
const {
    createActiveMissionFactSession,
    createProductionActiveMissionFactDomains,
} = require("../src/lib/mission/active-fact-session")
const { evaluateActiveMissionFact } = require("../src/lib/mission/active-fact-evaluator")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const restoreContentSnapshot = installBundledGameplaySnapshot()
data.initializeDatabase()

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("fact domain projects stored EX quest ids into the +10M Active Mission namespace", t => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `active-mission-ex-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    // 存储侧保持原始 id（与客户端结算写入一致）
    insertPlayerQuestProgressSync(playerId, 4, { questId: 1001001, finished: true, clearRank: 5 })
    insertPlayerQuestProgressSync(playerId, 1, { questId: 1001002, finished: true, clearRank: 5 })

    const session = createActiveMissionFactSession({
        playerId,
        plan: getActiveMissionPlan(),
        domains: createProductionActiveMissionFactDomains(),
    })
    const snapshot = session.loadKinds(["questProgress"])

    const exProgress = snapshot.facts.questProgress.find(quest => quest.category === 4)
    assert.equal(exProgress.questId, 11_001_001, "EX 进度在事实域必须位于 +10M 命名空间")
    const mainProgress = snapshot.facts.questProgress.find(quest => quest.category === 1)
    assert.equal(mainProgress.questId, 1001002, "主线进度 id 不受影响")
    assert.equal(snapshot.facts.finishedQuestIds.has(11_001_001), true)
    assert.equal(snapshot.facts.finishedQuestIds.has(1001001), false, "原始 EX id 不应残留")
})

test("PATTERN_QUEST_CLEAR counts finished EX quests from raw stored progress", t => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `active-mission-ex-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertPlayerQuestProgressSync(playerId, 4, { questId: 1001001, finished: true, clearRank: 5 })
    insertPlayerQuestProgressSync(playerId, 4, { questId: 1002001, finished: false })

    const session = createActiveMissionFactSession({
        playerId,
        plan: getActiveMissionPlan(),
        domains: createProductionActiveMissionFactDomains(),
    })
    const snapshot = session.loadKinds(["questProgress"])

    const definition = {
        missionId: 999_999,
        pattern: 57,
        evaluator: "static",
        row: [],
        targetMissionRequirements: [],
        questRange: { kind: 1, categories: [4], first: [1, 2], second: [1, 2], third: [1, 2] },
    }
    assert.equal(
        evaluateActiveMissionFact(definition, snapshot.facts, {}),
        1,
        "EX quest-clear 事实必须计入已完成关卡（原始存储 id）",
    )
})
