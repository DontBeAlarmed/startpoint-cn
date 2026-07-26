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
const { getDegreeBattleStatsSync } = require("../src/data/domains/degree_battle_stats")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { addPlayerShopPurchaseCountSync } = require("../src/data/domains/shopPurchase")
const { insertPlayerEquipmentSync } = require("../src/data/domains/equipment")
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
const {
    getExactDegreeQuestClearRuleCount,
    recordDegreeMissionBattleFacts,
} = require("../src/lib/mission/degree-battle-facts")
const { recordDegreeBattleStatisticsSync } = require("../src/lib/mission/degree-battle-stat-facts")
const {
    getDegreeOperationRuleCount,
    recordDegreeOperationFactsSync,
} = require("../src/lib/mission/degree-operation-facts")

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
updatePlayerCategoryMissionSync(playerId, 5, 31010, 9)
updatePlayerCategoryMissionSync(playerId, 5, 59210, 5)
updatePlayerCategoryMissionSync(playerId, 5, 45010, 10)
recordDegreeOperationFactsSync(playerId, "treasure_mana", 100)
recordDegreeOperationFactsSync(playerId, "equipment_upgrade", 4)
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 2,
    questId: 1025001,
    accomplished: true,
})
recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 2,
    questId: 1025001,
    questAccomplished: true,
}, new Date("2024-08-14T12:00:00.000Z"))
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    isHost: false,
    questCategory: 2,
    questId: 1025002,
    accomplished: true,
})
recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 2,
    questId: 1025002,
    questAccomplished: true,
}, new Date("2024-08-14T12:00:00.000Z"))
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 2,
    questId: 1025003,
    accomplished: false,
})
recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 2,
    questId: 1025003,
    questAccomplished: false,
}, new Date("2024-08-14T12:00:00.000Z"))
for (let index = 0; index < 3; index++) {
    recordMissionBattleResultSync(playerId, {
        isMulti: index % 2 === 1,
        questCategory: 7,
        questId: 200006001 + index,
        accomplished: true,
    })
    recordDegreeMissionBattleFacts({
        playerId,
        questCategory: 7,
        questId: 200006001 + index,
        questAccomplished: true,
    }, new Date("2024-08-14T12:00:00.000Z"))
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
insertPlayerQuestProgressSync(playerId, 22, { questId: 1003, finished: true })
insertPlayerQuestProgressSync(playerId, 22, { questId: 1006, finished: false })
insertPlayerQuestProgressSync(playerId, 26, { questId: 1001001, finished: true })

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
givePlayerItemSync(playerId, 70014, 3000)
givePlayerItemSync(playerId, 70048, 1000)

recordDegreeBattleStatisticsSync({
    playerId,
    questAccomplished: true,
    isMulti: false,
    statistics: {
        zones: [
            {
                fever_count: 2,
                fever_ms: 100,
                use_debuff_to_enemy_count: 3,
                clear_buff_of_enemy_count: 4,
                clear_debuff_of_self_count: 5,
                enemy_kill_count: 6,
                weak_point_attack_count: 7,
                use_power_flip_lv3_count: 8,
                coffin_count_reduced_count: 9,
                damage_deal_max: 1_000_000,
                max_coffin_count_by_revival: 10,
                use_buff_to_all_party_members: 999,
                use_emotion_count: 999,
            },
            {
                fever_count: 3,
                fever_ms: 200,
                enemy_kill_count: 4,
                damage_deal_max: 5_000_000,
            },
        ],
        max_power: 7500,
        max_skill_chain_count: 7,
    },
})
recordDegreeBattleStatisticsSync({
    playerId,
    questAccomplished: true,
    isMulti: true,
    statistics: {
        zones: [{
            use_buff_to_all_party_members: 11,
            use_heal_to_all_party_members: 12.5,
            use_emotion_count: 2,
            enemy_kill_count: 13,
            weak_point_attack_count: 14,
            use_power_flip_lv3_count: 15,
            coffin_count_reduced_count: 16,
            damage_deal_max: 4_000_000,
            max_coffin_count_by_revival: 9,
            fever_count: 999,
            clear_buff_of_enemy_count: 999,
        }],
        max_power: 8000,
        max_skill_chain_count: 6,
    },
})
recordDegreeBattleStatisticsSync({
    playerId,
    questAccomplished: false,
    isMulti: false,
    statistics: { zones: [{ fever_count: 999 }] },
})
recordDegreeBattleStatisticsSync({
    playerId,
    questAccomplished: true,
    isMulti: false,
    statistics: {
        zones: [
            {
                fever_count: -1,
                fever_ms: 1.5,
                enemy_kill_count: Number.MAX_SAFE_INTEGER,
                damage_deal_max: Number.POSITIVE_INFINITY,
                max_coffin_count_by_revival: -1,
            },
            { enemy_kill_count: 1 },
        ],
        max_power: 1.5,
        max_skill_chain_count: -1,
    },
})
recordDegreeBattleStatisticsSync({
    playerId,
    questAccomplished: true,
    isMulti: true,
    statistics: { zones: [{ use_heal_to_all_party_members: Number.NaN }] },
})

const overflowAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-degree-overflow-${randomUUID()}`,
    status: "normal",
})
const overflowPlayerId = insertDefaultPlayerSync(overflowAccount.id).id
for (const value of [Number.MAX_SAFE_INTEGER, 1]) {
    recordDegreeBattleStatisticsSync({
        playerId: overflowPlayerId,
        questAccomplished: true,
        isMulti: false,
        statistics: { zones: [{ fever_count: value }] },
    })
    recordDegreeBattleStatisticsSync({
        playerId: overflowPlayerId,
        questAccomplished: true,
        isMulti: true,
        statistics: { zones: [{ use_heal_to_all_party_members: value }] },
    })
}
assert.equal(getDegreeBattleStatsSync(overflowPlayerId).feverCount, Number.MAX_SAFE_INTEGER)
assert.equal(getDegreeBattleStatsSync(overflowPlayerId).healPartyCount, Number.MAX_SAFE_INTEGER)

const equipmentDissolve = require("../assets/equipment_dissolve.json")
const maxLevelEquipmentIds = Object.entries(equipmentDissolve)
    .filter(([, row]) => Number.isSafeInteger(row.max_level) && row.max_level > 0)
    .slice(-6)
for (const [index, [equipmentId, row]] of maxLevelEquipmentIds.entries()) {
    insertPlayerEquipmentSync(playerId, equipmentId, {
        level: index < 5 ? row.max_level : Math.max(1, row.max_level - 1),
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })
}

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
assert.equal(DegreeComputer.compute(61040, context, 0), 1, "Carnival 精确关卡完成后应达成称号")
assert.equal(DegreeComputer.compute(61050, context, 0), 0, "Carnival 未完成关卡不得达成称号")
assert.equal(DegreeComputer.compute(62330, context, 0), 1, "HardMulti 精确关卡完成后应达成称号")
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
assert.equal(DegreeComputer.compute(30000, context, 0), 12, "领主战称号应读取 category 2 成功累计")
assert.equal(DegreeComputer.compute(30010, context, 0), 12, "领主战称号应支持更高阈值")
assert.equal(DegreeComputer.compute(30020, context, 1), 12, "领主战称号旧进度与新事实取最大值")
assert.equal(DegreeComputer.compute(37000, context, 0), 5000, "冲刺称号应读取玩家累计冲刺次数")
assert.equal(DegreeComputer.compute(37010, context, 0), 5000, "冲刺称号应支持更高阈值")
assert.equal(DegreeComputer.compute(37020, context, 7000), 7000, "冲刺称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(34000, context, 0), 500, "单次连击称号应读取历史最高连击")
assert.equal(DegreeComputer.compute(34010, context, 0), 500, "单次连击称号应支持更高阈值")
assert.equal(DegreeComputer.compute(34020, context, 700), 700, "单次连击称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(41000, context, 0), 1500, "锻造石称号应读取累计获得量")
assert.equal(DegreeComputer.compute(41010, context, 0), 1500, "锻造石称号应支持更高阈值")
assert.equal(DegreeComputer.compute(41020, context, 3000), 3000, "锻造石称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(70000, context, 0), 3000, "活动累计物品称号应读取历史获得量")
assert.equal(DegreeComputer.compute(70010, context, 2000), 2000, "活动累计物品称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(43000, context, 0), 5, "满级装备称号应按权威 max_level 统计")
assert.equal(DegreeComputer.compute(43010, context, 8), 8, "满级装备称号旧进度不得倒退")
assert.equal(DegreeComputer.compute(33000, context, 0), 600, "技能使用称号应读取成功战斗累计")
assert.equal(DegreeComputer.compute(33010, context, 0), 600, "技能使用称号应支持更高阈值")
assert.equal(DegreeComputer.compute(33020, context, 700), 700, "技能使用称号旧进度不得倒退")
const degreeProgress = missionId => getPlayerCategoryMissionsSync(playerId, 5)[missionId]?.progress ?? 0
assert.equal(DegreeComputer.compute(31000, context, degreeProgress(31000)), 2, "指定 Boss 组应累计单人与协力成功结算")
assert.equal(DegreeComputer.compute(31010, context, degreeProgress(31010)), 11, "指定 Boss 累计称号应从旧进度继续增长")
assert.equal(DegreeComputer.compute(31100, context, 0), 0, "其他 Boss 组不得计入指定组")
assert.equal(DegreeComputer.compute(59200, context, degreeProgress(59200)), 3, "指定 Advent 活动应累计全部目标关卡")
assert.equal(DegreeComputer.compute(59210, context, degreeProgress(59210)), 8, "指定 Advent 累计称号应从旧进度继续增长")
assert.equal(DegreeComputer.compute(16000, context, 0), 5, "单人 FEVER 次数应跨 zone 累计")
assert.equal(DegreeComputer.compute(17000, context, 0), 300, "单人 FEVER 时间应累计毫秒")
assert.equal(DegreeComputer.compute(18000, context, 0), 3, "单人弱化敌人次数应累计")
assert.equal(DegreeComputer.compute(19000, context, 0), 4, "单人消除敌人强化次数应累计")
assert.equal(DegreeComputer.compute(20000, context, 0), 5, "单人净化自身弱化次数应累计")
assert.equal(DegreeComputer.compute(21000, context, 0), 11, "协力全队强化次数应累计")
assert.equal(DegreeComputer.compute(22000, context, 0), 12.5, "协力全队回复量应保留合法 Float")
assert.equal(DegreeComputer.compute(28000, context, 0), 2, "协力表情次数应累计")
assert.equal(DegreeComputer.compute(29000, context, 0), 23, "击杀数应累计单人与协力")
assert.equal(DegreeComputer.compute(36000, context, 0), 21, "弱点破坏应累计单人与协力")
assert.equal(DegreeComputer.compute(38000, context, 0), 23, "Lv3 PF 应累计单人与协力")
assert.equal(DegreeComputer.compute(40000, context, 0), 25, "棺柩减少数应累计单人与协力")
assert.equal(DegreeComputer.compute(35000, context, 0), 5_000_000, "单次伤害应取历史最大")
assert.equal(DegreeComputer.compute(39000, context, 0), 10, "复活棺柩数应取历史最大")
assert.equal(DegreeComputer.compute(32000, context, 0), 8000, "队伍战力应取历史最大")
assert.equal(DegreeComputer.compute(27000, context, 0), 7, "技能连锁数应取历史最大")
assert.equal(DegreeComputer.compute(26000, context, 4), 4, "缺少权威 MVP 聚合时必须保留 fallback")
assert.equal(DegreeComputer.compute(45000, context, degreeProgress(45000)), 100)
assert.equal(DegreeComputer.compute(45010, context, degreeProgress(45010)), 110)
assert.equal(DegreeComputer.compute(42000, context, degreeProgress(42000)), 4)
assert.equal(DegreeComputer.compute(8000, context, 3), 3, "魂珠验证未闭合时必须保留 fallback")

for (const missionId of [23000, 23010, 23020]) {
    assert.equal(DegreeComputer.compute(missionId, context, 0), 4, `${missionId} 应读取协力成功总数`)
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
assert.equal(getExactDegreeQuestClearRuleCount(), 84)
assert.equal(getDegreeOperationRuleCount(), 6)
assert.deepEqual(coverage, {
    total: 1288,
    serverComputed: 1268,
    unsupported: 20,
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
        carnivalQuestClear: 27,
        hardMultiQuestClear: 6,
        specifiedQuestClearCount: 84,
        feverCount: 3,
        feverTime: 3,
        debuffEnemy: 3,
        clearEnemyBuff: 3,
        clearSelfDebuff: 3,
        buffParty: 3,
        healParty: 3,
        emotionUse: 3,
        enemyKill: 3,
        weakPointAttack: 3,
        powerFlipLv3: 3,
        coffinReduced: 3,
        damageMax: 3,
        revivalCoffinMax: 1,
        partyPowerMax: 3,
        skillChainMax: 3,
        operationFacts: 6,
        challengeDungeonClear: 3,
        scoreClearSingle: 3,
        timeClearSingle: 3,
        bossBattleClear: 3,
        dashUse: 3,
        comboOneTime: 3,
        craftPointGet: 3,
        eventCollectItem: 2,
        maxLevelEquipment: 3,
        skillUse: 3,
    },
})

console.log("mission degree progress tests passed")
cleanup()
process.removeListener("exit", cleanup)
