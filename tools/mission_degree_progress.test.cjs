require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-progress-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
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
    insertPlayerCharacterManaNodesSync,
    insertPlayerCharacterSync,
} = require("../src/data/domains/character")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    countFinishedPlayerQuestsByCategorySync,
    insertPlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const {
    DegreeComputer,
    getDegreeMissionCoverageReport,
} = require("../src/lib/mission/computer-degree")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-degree-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
updatePlayerSync({ id: playerId, rankPoint: Number.MAX_SAFE_INTEGER })

function insertCharacter(characterId, overLimitStep, bondStatus) {
    const now = new Date("2024-01-01T00:00:00.000Z")
    insertPlayerCharacterSync(playerId, characterId, {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep,
        protection: false,
        joinTime: now,
        updateTime: now,
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [{ manaBoardIndex: 1, status: bondStatus }],
    })
}

insertCharacter(900001, 2, 1)
insertCharacter(900002, 3, 1)
insertCharacter(111001, 0, 1)
insertCharacter(111002, 0, 0)
insertCharacter(111003, 0, 2)
insertPlayerCharacterManaNodesSync(playerId, 1, [101])
insertPlayerCharacterManaNodesSync(playerId, 900001, [201, 202])
insertPlayerCharacterManaNodesSync(playerId, 900002, [301])

recordMissionBattleResultSync(playerId, { isMulti: true, isHost: true, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: true, isHost: false, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: true, isHost: true, accomplished: false, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true, clearRank: 5 })

insertPlayerQuestProgressSync(playerId, 3, { questId: 300001, finished: true })
insertPlayerQuestProgressSync(playerId, 3, { questId: 300002, finished: true })
insertPlayerQuestProgressSync(playerId, 3, { questId: 300003, finished: false })
insertPlayerQuestProgressSync(playerId, 1, { questId: 100001, finished: true })

const degreeComputerSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/mission/computer-degree.ts"),
    "utf8",
)
assert.match(degreeComputerSource, /countFinishedPlayerQuestsByCategorySync\(playerId, 3\)/)
assert.doesNotMatch(degreeComputerSource, /getPlayerQuestProgressSync/)

assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 3), 2)
assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 1), 1)
assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 99), 0)

const context = DegreeComputer.buildContext(playerId, 5)
assert.equal(DegreeComputer.compute(1000, context, 0), 250)
assert.equal(DegreeComputer.compute(2000, context, 0), 6)
assert.equal(DegreeComputer.compute(4000, context, 0), 5)
assert.equal(DegreeComputer.compute(5000, context, 0), 4)
assert.equal(DegreeComputer.compute(6000, context, 0), 4)
assert.equal(DegreeComputer.compute(13000, context, 0), 1, "多人 SS 不得计入单人 SS 称号")
assert.equal(DegreeComputer.compute(3000, context, 7), 7, "缺少完整等级曲线时保留已有进度")
assert.equal(DegreeComputer.compute(111001, context, 0), 1, "指定角色获得信赖之证后应完成称号")
assert.equal(DegreeComputer.compute(111002, context, 0), 0, "未获得信赖之证的角色不得完成称号")
assert.equal(DegreeComputer.compute(111003, context, 0), 1, "已领取信赖之证后称号仍必须保持完成")

for (const missionId of [23000, 23010, 23020]) {
    assert.equal(DegreeComputer.compute(missionId, context, 0), 2, `${missionId} 应读取协力成功总数`)
    assert.equal(DegreeComputer.compute(missionId, context, 9), 9, `${missionId} 不得降低旧进度`)
}
for (const missionId of [24000, 24010, 24020]) {
    assert.equal(DegreeComputer.compute(missionId, context, 0), 1, `${missionId} 应只读取房主协力成功数`)
    assert.equal(DegreeComputer.compute(missionId, context, 9), 9, `${missionId} 不得降低旧进度`)
}
for (const missionId of [7000, 7010, 7020]) {
    assert.equal(DegreeComputer.compute(missionId, context, 0), 2, `${missionId} 应只统计已完成角色剧情`)
    assert.equal(DegreeComputer.compute(missionId, context, 9), 9, `${missionId} 不得降低旧进度`)
}

const coverage = getDegreeMissionCoverageReport()
assert.deepEqual(coverage, {
    total: 1288,
    serverComputed: 516,
    unsupported: 772,
    supportedFamilies: {
        playerRank: 8,
        companionCount: 3,
        overLimitCount: 3,
        manaBoardCount: 3,
        bondTokenCount: 3,
        singleSsCount: 3,
        multiClearCount: 3,
        multiHostClearCount: 3,
        episodeClearCount: 3,
        specificCharacterBond: 484,
    },
})

console.log("mission degree progress tests passed")
cleanup()
process.removeListener("exit", cleanup)
