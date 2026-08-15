"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-scope-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
const restorers = []
function cleanup() {
    for (const restore of restorers.splice(0).reverse()) restore()
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
const characterDomain = require("../src/data/domains/character")
const missionBattleDomain = require("../src/data/domains/mission_battle_facts")
const degreeBattleDomain = require("../src/data/domains/degree_battle_stats")
const shopDomain = require("../src/data/domains/shopPurchase")
const itemDomain = require("../src/data/domains/item")
const questDomain = require("../src/data/domains/quest")
const equipmentDomain = require("../src/data/domains/equipment")
const playerDomain = require("../src/data/domains/player")

initializeDatabase()
db = getDb()

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-degree-scope-${randomUUID()}`,
    status: "normal",
})
const playerId = playerDomain.insertDefaultPlayerSync(account.id).id
playerDomain.updatePlayerSync({
    id: playerId,
    rankPoint: Number.MAX_SAFE_INTEGER,
    totalStaminaUsed: 123,
    totalDashes: 45,
    maxComboAchieved: 67,
    totalLoginDays: 89,
})
characterDomain.insertPlayerCharacterSync(playerId, 111001, {
    entryCount: 1,
    evolutionLevel: 0,
    overLimitStep: 4,
    protection: false,
    joinTime: new Date("2024-01-01T00:00:00.000Z"),
    updateTime: new Date("2024-01-01T00:00:00.000Z"),
    exp: 379988,
    stack: 0,
    manaBoardIndex: 1,
    bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
})
characterDomain.insertPlayerCharacterManaNodesSync(playerId, 111001, [101, 102])
missionBattleDomain.recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    clearRank: 5,
    skillUseCount: 7,
})
degreeBattleDomain.recordDegreeBattleStatsSync(playerId, {
    feverCount: 5,
    feverMs: 6,
    debuffEnemyCount: 7,
    clearEnemyBuffCount: 8,
    clearSelfDebuffCount: 9,
    buffPartyCount: 10,
    healPartyCount: 11,
    emotionCount: 12,
    enemyKillCount: 13,
    weakPointAttackCount: 14,
    powerFlipLv3Count: 15,
    coffinReducedCount: 16,
    damageDealMax: 17,
    revivalCoffinMax: 18,
    partyPowerMax: 19,
    skillChainMax: 20,
})
questDomain.insertPlayerQuestProgressSync(playerId, 21, {
    questId: 1001,
    finished: true,
})
itemDomain.givePlayerItemSync(playerId, 70014, 9)

const calls = []
function instrument(domain, functionName, family) {
    const original = domain[functionName]
    assert.equal(typeof original, "function", `${functionName} 必须是真实 domain 函数`)
    domain[functionName] = (...args) => {
        calls.push({ family, functionName, args })
        return original(...args)
    }
    restorers.push(() => { domain[functionName] = original })
}

instrument(playerDomain, "getPlayerSync", "player")
instrument(characterDomain, "getPlayerCharactersSync", "character")
instrument(characterDomain, "getPlayerCharactersManaNodesSync", "mana")
instrument(missionBattleDomain, "getMissionBattleCountersSync", "battleCounters")
instrument(degreeBattleDomain, "getDegreeBattleStatsSync", "degreeBattleStats")
instrument(shopDomain, "getPlayerShopPurchasesMapSync", "shop")
instrument(itemDomain, "getPlayerCollectedItemTotalsByIdsSync", "selectedItems")
instrument(questDomain, "getPlayerQuestProgressSync", "questProgress")
instrument(equipmentDomain, "getPlayerEquipmentListSync", "equipment")

// Domain instrumentation must be installed before this import.
const {
    DegreeComputer,
    getDegreeComputedMissionIds,
} = require("../src/lib/mission/computer-degree")
const { getMissionMasterDefinitions } = require("../src/lib/mission/master-data")
const {
    buildBattleMissionSettlementScopes,
} = require("../src/lib/mission/battle-facts")

const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const resetCalls = () => { calls.length = 0 }
const countFamily = family => calls.filter(call => call.family === family).length
const touchedFamilies = () => new Set(calls.map(call => call.family))
const assertUntouched = families => {
    for (const family of families) {
        assert.equal(countFamily(family), 0, `${family} 不应被读取：${JSON.stringify(calls)}`)
    }
}

const fullContext = DegreeComputer.buildContext(playerId, 5, evaluationTime)
const fullFamilies = touchedFamilies()
for (const family of [
    "player", "character", "mana", "battleCounters", "degreeBattleStats",
    "shop", "selectedItems", "questProgress", "equipment",
]) {
    assert.equal(fullFamilies.has(family), true, `全量上下文探针未触发 ${family}`)
}

resetCalls()
const rankContext = DegreeComputer.buildContext(playerId, 5, evaluationTime, [1000])
assert.equal(DegreeComputer.compute(1000, rankContext, 0), DegreeComputer.compute(1000, fullContext, 0))
assert.equal(countFamily("player") > 0, true, "rank-only 必须正向触发玩家事实探针")
assertUntouched([
    "character", "mana", "battleCounters", "degreeBattleStats", "shop", "selectedItems",
    "questProgress", "equipment",
])

resetCalls()
const battleStatContext = DegreeComputer.buildContext(playerId, 5, evaluationTime, [16000])
assert.equal(DegreeComputer.compute(16000, battleStatContext, 0), DegreeComputer.compute(16000, fullContext, 0))
assert.equal(countFamily("degreeBattleStats") > 0, true, "FEVER 候选必须读取称号战斗统计")
assertUntouched([
    "character", "mana", "battleCounters", "shop", "selectedItems",
    "questProgress", "equipment",
])

const representativeMissionIds = [1000, 111001, 33000, 16000, 57010, 70000]
resetCalls()
const scopedContext = DegreeComputer.buildContext(
    playerId,
    5,
    evaluationTime,
    representativeMissionIds,
)
for (const missionId of representativeMissionIds) {
    assert.equal(
        DegreeComputer.compute(missionId, scopedContext, 0),
        DegreeComputer.compute(missionId, fullContext, 0),
        `${missionId} scoped/full 计算结果必须一致`,
    )
}
for (const family of ["player", "character", "battleCounters", "degreeBattleStats", "questProgress", "selectedItems"]) {
    assert.equal(countFamily(family) > 0, true, `代表性候选必须正向触发 ${family}`)
}
assertUntouched(["mana", "shop", "equipment"])

const battleDegreeScope = buildBattleMissionSettlementScopes([])
    .find(scope => typeof scope === "object" && scope.category === 5)
assert.ok(battleDegreeScope, "真实战斗 scope 必须包含 Category 5")
resetCalls()
DegreeComputer.buildContext(playerId, 5, evaluationTime, battleDegreeScope.missionIds)
const battleFamilies = touchedFamilies()
for (const family of ["player", "character", "battleCounters", "degreeBattleStats", "questProgress", "selectedItems"]) {
    assert.equal(battleFamilies.has(family), true, `真实 battle scope 探针未触发 ${family}`)
}
assertUntouched(["mana", "shop", "equipment"])
assert.equal(
    battleFamilies.size < fullFamilies.size,
    true,
    `真实 battle scope 应少于 full context：battle=${[...battleFamilies]} full=${[...fullFamilies]}`,
)

resetCalls()
const fallbackContext = DegreeComputer.buildContext(
    playerId,
    5,
    evaluationTime,
    [3000, 25000, 70004, 999999],
)
for (const missionId of [3000, 25000, 70004, 999999]) {
    assert.equal(DegreeComputer.compute(missionId, fallbackContext, 7), 7)
}
assertUntouched([
    "character", "mana", "battleCounters", "degreeBattleStats", "shop", "selectedItems",
    "questProgress", "equipment",
])

const {
    getDegreeMissionFactRequirements,
} = require("../src/lib/mission/degree-context-requirements")
const computedMissionIds = new Set(getDegreeComputedMissionIds())
const classificationMismatches = getMissionMasterDefinitions(5)
    .filter(definition => (
        computedMissionIds.has(definition.missionId)
        !== (getDegreeMissionFactRequirements(definition) !== undefined)
    ))
    .map(definition => definition.missionId)
assert.deepEqual(
    classificationMismatches,
    [],
    "事实需求分类必须与全部 computed mission 精确一致",
)

console.log("mission degree context scope tests passed")
cleanup()
process.removeListener("exit", cleanup)
