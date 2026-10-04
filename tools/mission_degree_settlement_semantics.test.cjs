"use strict"

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-settlement-semantics-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerDegreeIdsSync } = require("../src/data/domains/degree")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const legacyFixture = require("./fixtures/mission-degree/legacy-f8be414.json")

initializeDatabase()
const db = getDb()

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `degree-settlement-semantics-${randomUUID()}`,
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    updatePlayerSync({ id: player.id, rankPoint: Number.MAX_SAFE_INTEGER })
    return player.id
}

function captureSettlement(playerId) {
    const counts = { candidates: 0, computed: 0, progressChanged: 0 }
    let statements = 0
    let writes = 0
    let transactions = 0
    const originalPrepare = db.prepare.bind(db)
    const originalTransaction = db.transaction.bind(db)
    let settlement
    db.prepare = statement => {
        statements++
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(statement))) writes++
        return originalPrepare(statement)
    }
    db.transaction = (...args) => {
        transactions++
        return originalTransaction(...args)
    }
    try {
        settlement = settleMissionCategories(
            playerId,
            [{ category: 5, missionIds: [1000] }],
            new Date("2024-08-14T12:00:00.000Z"),
            {
                onCategoryCandidates(_category, count) { counts.candidates += count },
                onMissionComputed() { counts.computed++ },
                onMissionProgressChanged() { counts.progressChanged++ },
            },
        )
    } finally {
        db.prepare = originalPrepare
        db.transaction = originalTransaction
    }
    const mission = getPlayerCategoryMissionsSync(playerId, 5)[1000]
    return {
        counts,
        rewards: settlement.missionInfo.length,
        response: {
            missionInfo: settlement.missionInfo,
            itemList: settlement.itemList,
            characterList: settlement.characterList,
            equipmentList: settlement.equipmentList,
            degreeIds: settlement.degreeIds,
            passCardPoints: settlement.passCardPoints,
            userInfo: settlement.userInfo ?? null,
        },
        persisted: {
            missionId: 1000,
            progress: mission.progress,
            stages: mission.stages,
        },
        statements,
        writes,
        transactions,
    }
}

test("Category 5 Session settlement preserves the equipped degree and remains idempotent", () => {
    const sessionPlayerId = createPlayer()
    const first = captureSettlement(sessionPlayerId)
    const repeated = captureSettlement(sessionPlayerId)

    assert.deepEqual(Object.keys(first.response).sort(), [
        "characterList", "degreeIds", "equipmentList", "itemList",
        "missionInfo", "passCardPoints", "userInfo",
    ])
    // fixture 是 pre-5B 历史证据(锁定单发行为),级联后不再深比较;
    // 改为动态断言:首条任务 1000 + 级联追加的 player 族称号
    const missionIds = first.response.missionInfo.map(entry => entry.mission_id)
    assert.equal(missionIds[0], 1000, "首条必须是任务 1000")
    assert.deepEqual(getPlayerDegreeIdsSync(sessionPlayerId).sort((a, b) => a - b),
        [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070])
    assert.equal(getPlayerSync(sessionPlayerId).degreeId, 1)
    assert.equal(first.rewards > 0, true)
    assert.equal(first.writes > 0, true)
    assert.equal(first.transactions >= 1, true)
    assert.deepEqual(repeated.counts, { candidates: 1, computed: 1, progressChanged: 0 })
    assert.equal(repeated.rewards, 0)
    assert.deepEqual(repeated.response, legacyFixture.settlement.repeated.response)
    assert.deepEqual(repeated.persisted, legacyFixture.settlement.repeated.persisted)
    // 幂等:重复结算无奖励、无写、无级联轮(单事务)
    assert.equal(repeated.writes, 0)
    assert.equal(first.statements > repeated.statements, true)
})
test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
