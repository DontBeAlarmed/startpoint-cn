"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-regular-equivalence-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertPlayerCharacterManaNodesSync,
    insertPlayerCharacterSync,
} = require("../src/data/domains/character")
const { recordDegreeBattleStatsSync } = require("../src/data/domains/degree_battle_stats")
const { insertPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { getDb } = require("../src/data/db")
const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { RegularComputer } = require("../src/lib/mission/computer-regular")
const { bundledMissionContentRepository } = require("../src/lib/mission/mission-catalog-source")
const manaBoard = require("../assets/mana_board.json")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function replaceWithNonzeroFacts(playerId) {
    db.prepare("DELETE FROM players_characters_mana_nodes WHERE player_id = ?").run(playerId)
    db.prepare("DELETE FROM players_characters_bond_tokens WHERE player_id = ?").run(playerId)
    db.prepare("DELETE FROM players_characters WHERE player_id = ?").run(playerId)
    const secondBoardNodeIds = Object.values(manaBoard[1][2]).map(rows => Number(rows[0][0]))
    insertPlayerCharacterSync(playerId, 1, {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 3,
        protection: false,
        joinTime: new Date(0),
        updateTime: new Date(0),
        exp: Number.MAX_SAFE_INTEGER,
        stack: 0,
        manaBoardIndex: 2,
        bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
    })
    insertPlayerCharacterManaNodesSync(playerId, 1, secondBoardNodeIds)
    insertPlayerEquipmentSync(playerId, 200001, {
        level: 5,
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })
    givePlayerItemSync(playerId, 100000, 31)
    recordDegreeBattleStatsSync(playerId, {
        feverCount: 7,
        feverMs: 8,
        debuffEnemyCount: 9,
        clearEnemyBuffCount: 10,
        clearSelfDebuffCount: 11,
        buffPartyCount: 12,
        healPartyCount: 13,
        emotionCount: 14,
        enemyKillCount: 15,
        weakPointAttackCount: 16,
        powerFlipLv3Count: 17,
        coffinReducedCount: 18,
        damageDealMax: 19,
        revivalCoffinMax: 20,
        partyPowerMax: 21,
        skillChainMax: 22,
    })
    for (const [section, questId, clearRank] of [
        [1, 1001001, 5],
        [3, 101001, 4],
        [4, 1001001, 5],
        [15, 1, 3],
    ]) {
        insertPlayerQuestProgressSync(playerId, section, { questId, finished: true, clearRank })
    }
    recordMissionBattleResultSync(playerId, {
        isMulti: false,
        accomplished: true,
        clearRank: 5,
        score: 5000,
        skillUseCount: 6,
    })
    recordMissionBattleResultSync(playerId, {
        isMulti: true,
        isHost: false,
        accomplished: true,
        clearRank: 4,
        skillUseCount: 7,
    })
    updatePlayerSync({
        id: playerId,
        rankPoint: 10000,
        totalDashes: 23,
        totalPowerflips: 24,
        totalManaObtained: 25,
        totalLoginDays: 26,
        maxComboAchieved: 27,
    })
}

function createSession(playerId, catalog, missionIds) {
    return new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: missionIds.map(missionId => ({ category: 1, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
}

test("legacy and Session contexts compute every Category 1 mission equivalently with nonzero facts", () => {
    const playerId = createPlayer("regular-equivalence")
    replaceWithNonzeroFacts(playerId)
    const catalog = getMissionCatalog()
    const missionIds = catalog.getMissionIds(1)
    const legacyContext = RegularComputer.buildContext(playerId, 1, evaluationTime, missionIds)
    const sessionContext = RegularComputer.buildContextFromSession(
        createSession(playerId, catalog, missionIds),
        1,
        missionIds,
    )

    assert.equal(missionIds.length, 120)
    for (const missionId of missionIds) {
        for (const dbProgress of [0, 2, 29]) {
            assert.equal(
                RegularComputer.compute(missionId, sessionContext, dbProgress),
                RegularComputer.compute(missionId, legacyContext, dbProgress),
                `Category 1 mission ${missionId} dbProgress ${dbProgress}`,
            )
        }
    }
})

test("Session Regular derivation reads character, mana board and config from its Catalog source", () => {
    const playerId = createPlayer("regular-catalog-source")
    replaceWithNonzeroFacts(playerId)
    givePlayerItemSync(playerId, 777777, 41)
    const tables = {
        "character.json": { 1: { rarity: 0 } },
        "mana_board.json": { 1: { 2: { 1: [[999999]] } } },
        "config.json": { craft_point_item_id: 777777 },
    }
    const repository = Object.freeze({
        info: () => bundledMissionContentRepository.info(),
        table(tableName) {
            return Object.prototype.hasOwnProperty.call(tables, tableName)
                ? tables[tableName]
                : bundledMissionContentRepository.table(tableName)
        },
    })
    const catalog = getMissionCatalog(repository)
    const missionIds = [36, 66, 96]
    const context = RegularComputer.buildContextFromSession(
        createSession(playerId, catalog, missionIds),
        1,
        missionIds,
    )

    assert.equal(RegularComputer.compute(36, context, 0), 0)
    assert.equal(RegularComputer.compute(66, context, 0), 41)
    assert.equal(RegularComputer.compute(96, context, 0), 0)
})
