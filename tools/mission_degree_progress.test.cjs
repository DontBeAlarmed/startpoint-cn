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

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertPlayerCharacterManaNodesSync,
    insertPlayerCharacterSync,
} = require("../src/data/domains/character")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { addPlayerShopPurchaseCountSync } = require("../src/data/domains/shopPurchase")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    countFinishedPlayerQuestsByCategorySync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const {
    DegreeComputer,
    getDegreeMissionCoverageReport,
} = require("../src/lib/mission/computer-degree")

const questProgressCountIndex = "idx_players_quest_progress_player_section_finished"
const initializerSource = fs.readFileSync(
    path.join(__dirname, "../src/data/initializers/wdfpData.ts"),
    "utf8",
)
assert.match(
    initializerSource,
    /CREATE INDEX IF NOT EXISTS idx_players_quest_progress_player_section_finished[\s\S]*?ON players_quest_progress \(player_id, section, finished\)/,
)

initializeDatabase()
db = getDb()
assert.equal(
    db.prepare("PRAGMA index_list('players_quest_progress')")
        .all().some(index => index.name === questProgressCountIndex),
    true,
)
db.prepare(`DROP INDEX ${questProgressCountIndex}`).run()
assert.equal(
    db.prepare("PRAGMA index_list('players_quest_progress')")
        .all().some(index => index.name === questProgressCountIndex),
    false,
)
closeDatabase()
initializeDatabase()
db = getDb()
assert.equal(
    db.prepare("PRAGMA index_list('players_quest_progress')")
        .all().some(index => index.name === questProgressCountIndex),
    true,
    "已有数据库重新启动时应恢复任务进度计数索引",
)
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-degree-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
updatePlayerSync({
    id: playerId,
    rankPoint: Number.MAX_SAFE_INTEGER,
    totalStaminaUsed: 5000,
    totalDashes: 5000,
    maxComboAchieved: 500,
    totalLoginDays: 30,
})

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

const manaBoard = require("../assets/mana_board.json")
const secondBoardNodeIds = characterId => Object.values(manaBoard[String(characterId)]["2"])
    .map(rows => Number(rows[0][0]))
assert.equal(secondBoardNodeIds(111001).length, 18)
insertPlayerCharacterManaNodesSync(playerId, 111001, secondBoardNodeIds(111001).slice(0, 2))
insertPlayerCharacterManaNodesSync(playerId, 111002, secondBoardNodeIds(111002))
insertPlayerCharacterManaNodesSync(playerId, 111003, secondBoardNodeIds(111003))

recordMissionBattleResultSync(playerId, { isMulti: true, isHost: true, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: true, isHost: false, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: true, isHost: true, accomplished: false, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    score: 60_000_000,
    clearTime: 4_000,
    skillUseCount: 600,
})
for (let index = 0; index < 99; index++) {
    recordMissionBattleResultSync(playerId, {
        isMulti: false,
        questCategory: 13,
        accomplished: true,
    })
}
for (let index = 0; index < 10; index++) {
    recordMissionBattleResultSync(playerId, {
        isMulti: false,
        questCategory: 2,
        accomplished: true,
    })
}

insertPlayerQuestProgressSync(playerId, 3, { questId: 300001, finished: true })
insertPlayerQuestProgressSync(playerId, 3, { questId: 300002, finished: true })
insertPlayerQuestProgressSync(playerId, 3, { questId: 300003, finished: false })
insertPlayerQuestProgressSync(playerId, 1, { questId: 100001, finished: true })

const mainQuests = require("../assets/main_quest.json")
const exQuests = require("../assets/ex_quest.json")
function insertChapterProgress(chapter, unfinishedQuestId = null) {
    for (const [table, section] of [[mainQuests, 1], [exQuests, 4]]) {
        for (const questId of Object.keys(table)) {
            if (Math.floor(Number(questId) / 1_000_000) !== chapter) continue
            insertPlayerQuestProgressSync(playerId, section, {
                questId: Number(questId),
                finished: Number(questId) !== unfinishedQuestId,
            })
        }
    }
}
const degreeComputerSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/mission/computer-degree.ts"),
    "utf8",
)
assert.match(degreeComputerSource, /countFinishedPlayerQuestsByCategorySync\(playerId, 3\)/)
assert.doesNotMatch(degreeComputerSource, /getPlayerQuestProgressSync/)

assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 3), 2)
assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 1), 1)
assert.equal(countFinishedPlayerQuestsByCategorySync(playerId, 99), 0)

insertChapterProgress(1)
insertChapterProgress(2, 2001001)
insertPlayerQuestProgressSync(playerId, 2, { questId: 1003004, finished: true })

for (let suffix = 1; suffix <= 12; suffix++) {
    insertPlayerQuestProgressSync(playerId, 21, {
        questId: 1000 + suffix,
        finished: suffix !== 2,
    })
}
insertPlayerQuestProgressSync(playerId, 1, { questId: 1002, finished: true })
insertPlayerQuestProgressSync(playerId, 18, { questId: 400004101, finished: true })
insertPlayerQuestProgressSync(playerId, 18, { questId: 400004103, finished: false })
insertPlayerQuestProgressSync(playerId, 7, { questId: 200050009, finished: true })

function insertPracticeProgress(questIds, clearRank = 5) {
    for (const questId of questIds) {
        insertPlayerQuestProgressSync(playerId, 15, {
            questId,
            finished: true,
            clearRank,
        })
    }
}
insertPracticeProgress([5, 15, 25, 35, 45, 55])
insertPracticeProgress([4, 14, 24, 34, 44, 54], 5)
updatePlayerQuestProgressSync(playerId, 15, { questId: 54, clearRank: 4 })

const treasureShopItemIds = Object.keys(require("../assets/treasure_shop.json")).map(Number)
addPlayerShopPurchaseCountSync(playerId, treasureShopItemIds[0], 40)
addPlayerShopPurchaseCountSync(playerId, treasureShopItemIds[1], 60)
addPlayerShopPurchaseCountSync(playerId, 999999, 100)
givePlayerItemSync(playerId, 100000, 1500)
givePlayerItemSync(playerId, 999999, 5000)

const episodeCountQueryPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT COUNT(*) AS count
    FROM players_quest_progress
    WHERE player_id = ? AND section = ? AND finished = 1
`).all(playerId, 3)
assert.equal(
    episodeCountQueryPlan.some(row => String(row.detail)
        .includes(`USING COVERING INDEX ${questProgressCountIndex}`)),
    true,
    JSON.stringify(episodeCountQueryPlan),
)

const context = DegreeComputer.buildContext(playerId, 5)
assert.equal(DegreeComputer.compute(1000, context, 0), 250)
assert.equal(DegreeComputer.compute(2000, context, 0), 6)
assert.equal(DegreeComputer.compute(4000, context, 0), 5)
assert.equal(DegreeComputer.compute(5000, context, 0), 42)
assert.equal(DegreeComputer.compute(6000, context, 0), 4)
assert.equal(DegreeComputer.compute(13000, context, 0), 1, "多人 SS 不得计入单人 SS 称号")
assert.equal(DegreeComputer.compute(3000, context, 7), 7, "缺少完整等级曲线时保留已有进度")
assert.equal(DegreeComputer.compute(52000, context, 0), 5000, "应读取玩家累计消耗体力")
assert.equal(DegreeComputer.compute(52010, context, 9000), 9000, "体力称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(53000, context, 0), 30, "应读取玩家累计登录天数")
assert.equal(DegreeComputer.compute(53010, context, 40), 40, "登录称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(9000, context, 0), 1, "主线和高难全部完成后应完成章节称号")
assert.equal(DegreeComputer.compute(9010, context, 0), 0, "章节缺少一个高难关卡时不得完成章节称号")
assert.equal(DegreeComputer.compute(9110, context, 0), 0, "没有主线与高难记录的章节不得完成章节称号")
assert.equal(DegreeComputer.compute(12000, context, 0), 1, "练习关卡全部达到 SS 后应完成称号")
assert.equal(DegreeComputer.compute(12010, context, 0), 0, "练习关卡缺少 SS 时不得完成称号")
assert.equal(DegreeComputer.compute(12010, context, 1), 1, "练习称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(46000, context, 0), 100, "应累计珍品商店商品购买次数")
assert.equal(DegreeComputer.compute(46010, context, 150), 150, "珍品商店称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(11010, context, 0), 1, "指定 Boss 超级关卡完成后应完成称号")
assert.equal(DegreeComputer.compute(11020, context, 0), 0, "未完成指定 Boss 超级关卡时不得完成称号")
assert.equal(DegreeComputer.compute(11080, context, 7), 7, "CDN 缺少指定难度映射时应保留持久化 fallback")
assert.equal(DegreeComputer.compute(57010, context, 0), 1, "ExpertSingle 精确关卡完成后应达成称号")
assert.equal(DegreeComputer.compute(57020, context, 0), 0, "其他 category 的同 ID 不得完成 ExpertSingle 称号")
assert.equal(DegreeComputer.compute(57020, context, 3), 3, "ExpertSingle 称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(58000, context, 0), 1, "WorldStory 精确关卡完成后应达成称号")
assert.equal(DegreeComputer.compute(58010, context, 0), 0, "WorldStory 未完成关卡不得达成称号")
assert.equal(DegreeComputer.compute(68000, context, 0), 1, "Advent 精确单人关卡完成后应达成称号")
assert.equal(DegreeComputer.compute(111001, context, 0), 1, "指定角色获得信赖之证后应完成称号")
assert.equal(DegreeComputer.compute(111002, context, 0), 0, "未获得信赖之证的角色不得完成称号")
assert.equal(DegreeComputer.compute(111003, context, 0), 1, "已领取信赖之证后称号仍必须保持完成")
assert.equal(
    DegreeComputer.compute(1111001, context, 0),
    0,
    "第二玛纳板未全部强化时不得完成指定角色称号",
)
assert.equal(
    DegreeComputer.compute(1111002, context, 0),
    1,
    "第二玛纳板全部强化后应完成指定角色称号",
)
assert.equal(
    DegreeComputer.compute(55000, context, 0),
    38,
    "应统计所有已确认的第二玛纳板节点，未知角色节点不得计入",
)
assert.equal(DegreeComputer.compute(55010, context, 0), 38, "全局第二板节点数应可用于 50 次阈值")
assert.equal(DegreeComputer.compute(55020, context, 200), 200, "旧称号进度不得因当前可见节点不足而倒退")
assert.equal(DegreeComputer.compute(10000, context, 0), 99, "挑战副本称号应读取成功通关累计次数")
assert.equal(DegreeComputer.compute(10010, context, 0), 99, "挑战副本累计次数应可用于更高阈值")
assert.equal(DegreeComputer.compute(10020, context, 120), 120, "挑战副本称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(14000, context, 0), 60_000_000, "单人分数称号应返回最高成功分数")
assert.equal(DegreeComputer.compute(14010, context, 0), 60_000_000, "单人分数称号应支持更高阈值")
assert.equal(DegreeComputer.compute(14020, context, 0), 60_000_000, "未达到最高档时仍应返回真实进度")
assert.equal(DegreeComputer.compute(14020, context, 70_000_000), 70_000_000, "单人分数称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(15000, context, 0), 1, "单人时间称号应读取最快成功时间")
assert.equal(DegreeComputer.compute(15010, context, 0), 1, "单人时间称号应支持更高阈值")
assert.equal(DegreeComputer.compute(15020, context, 0), 1, "单人时间称号应支持最高阈值")
assert.equal(DegreeComputer.compute(30000, context, 0), 10, "领主战称号应读取 category 2 成功累计")
assert.equal(DegreeComputer.compute(30010, context, 0), 10, "领主战称号应支持更高阈值")
assert.equal(DegreeComputer.compute(30020, context, 1), 10, "领主战称号旧进度与新事实取最大值")
assert.equal(DegreeComputer.compute(37000, context, 0), 5000, "冲刺称号应读取玩家累计冲刺次数")
assert.equal(DegreeComputer.compute(37010, context, 0), 5000, "冲刺称号应支持更高阈值")
assert.equal(DegreeComputer.compute(37020, context, 7000), 7000, "冲刺称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(34000, context, 0), 500, "单次连击称号应读取历史最高连击")
assert.equal(DegreeComputer.compute(34010, context, 0), 500, "单次连击称号应支持更高阈值")
assert.equal(DegreeComputer.compute(34020, context, 700), 700, "单次连击称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(41000, context, 0), 1500, "锻造石称号应读取累计获得量")
assert.equal(DegreeComputer.compute(41010, context, 0), 1500, "锻造石称号应支持更高阈值")
assert.equal(DegreeComputer.compute(41020, context, 3000), 3000, "锻造石称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(33000, context, 0), 600, "技能使用称号应读取成功战斗累计")
assert.equal(DegreeComputer.compute(33010, context, 0), 600, "技能使用称号应支持更高阈值")
assert.equal(DegreeComputer.compute(33020, context, 700), 700, "技能使用称号旧进度不得倒退")

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
    serverComputed: 1094,
    unsupported: 194,
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
        secondManaBoardNodeCount: 3,
        secondManaBoardCompletion: 472,
        staminaUseCount: 3,
        loginCount: 3,
        episodeChapterCompletion: 12,
        practiceRankSs: 5,
        treasureShopPurchaseCount: 3,
        bossBattleExClearSingle: 13,
        expertSingleQuestClear: 12,
        worldStoryQuestClear: 27,
        adventQuestClear: 1,
        challengeDungeonClear: 3,
        scoreClearSingle: 3,
        timeClearSingle: 3,
        bossBattleClear: 3,
        dashUse: 3,
        comboOneTime: 3,
        craftPointGet: 3,
        skillUse: 3,
    },
})

console.log("mission degree progress tests passed")
cleanup()
process.removeListener("exit", cleanup)
