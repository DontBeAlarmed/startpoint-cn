"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-awake-evaluation-settle-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerCharacterAwakeUnlocksSync } = require("../src/data/domains/character_awake")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { AwakeComputer } = require("../src/lib/mission/computer-awake")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const {
    settleAwakeBattleMissions,
    settleAwakeMissionCandidatesWithEvaluation,
} = require("../src/lib/mission/awake-settlement")
const { getFactKeyId } = require("../src/lib/mission/facts/fact-key")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2025-01-01T12:00:00.000Z")
const awakeMissionIds = [3410051, 3410052, 3410053, 3410054]
const awakeItemRewards = { 13: 10, 14: 5, 15: 3, 16: 1 }

function createEligiblePlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)
    const rarity = getCharacterDataSync(341005).rarity
    updatePlayerCharacterSync(playerId, 341005, { exp: characterExpCaps[rarity][0] })
    insertPlayerCharacterManaNodesSync(
        playerId,
        341005,
        Object.keys(getCharacterManaNodesSync(341005, 1)).map(Number),
    )
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 341005, 5, 2, 3, 1, 0)
    `).run(playerId)
    return playerId
}

function itemAmounts(playerId) {
    return Object.fromEntries(Object.keys(awakeItemRewards).map(itemId => [
        itemId,
        getPlayerItemSync(playerId, Number(itemId)) ?? 0,
    ]))
}

function expectedRewardBalances(before) {
    return Object.fromEntries(Object.entries(awakeItemRewards).map(([itemId, amount]) => [
        itemId,
        before[itemId] + amount,
    ]))
}

test("battle seam evaluates immutable Session results and returns rewards and unlock immediately", () => {
    const playerId = createEligiblePlayer("awake-seam")
    const before = itemAmounts(playerId)
    const originalLegacyBuilder = AwakeComputer.buildContext
    AwakeComputer.buildContext = () => { throw new Error("awake settlement must not use legacy context") }
    let settlement
    try {
        settlement = settleAwakeBattleMissions({
            playerId,
            questAccomplished: true,
            characterIds: [341005],
            directlyChangedMissionIds: [],
            evaluationTime,
        })
    } finally {
        AwakeComputer.buildContext = originalLegacyBuilder
    }

    assert.deepEqual(settlement.missionInfo, awakeMissionIds.map(missionId => ({
        mission_category_id: 9,
        mission_id: missionId,
        mission_reward_id: missionId * 10 + 1,
    })))
    assert.deepEqual(settlement.itemList, expectedRewardBalances(before))
    assert.deepEqual(
        settlement.characterList.find(entry => entry.character_id === 341005)?.mana_board_awake,
        { 1: 1 },
    )
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
    assert.deepEqual(Object.fromEntries(Object.entries(getPlayerCategoryMissionsSync(playerId, 9))
        .map(([missionId, mission]) => [missionId, mission.progress])), {
        3410051: 5,
        3410052: 5,
        3410053: 5,
        3410054: 3,
    })

    const repeated = settleAwakeBattleMissions({
        playerId,
        questAccomplished: true,
        characterIds: [341005],
        directlyChangedMissionIds: [],
        evaluationTime,
    })
    assert.deepEqual(repeated.missionInfo, [])
    assert.deepEqual(repeated.itemList, {})
    assert.deepEqual(repeated.characterList, [])
    assert.deepEqual(itemAmounts(playerId), expectedRewardBalances(before))
})

test("special Awake unlock invalidates only awake eligibility when the upsert changes state", () => {
    const playerId = createEligiblePlayer("awake-unlock-invalidation")
    const result = settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        awakeMissionIds,
        evaluationTime,
    )
    const invalidationIds = result.invalidatedFactKeys.map(getFactKeyId)

    assert.equal(invalidationIds.includes("awakeEligibility"), true)
    assert.equal(invalidationIds.filter(id => id === "awakeEligibility").length, 1)
    assert.equal(invalidationIds.includes("characters"), false)
    assert.equal(invalidationIds.includes("characterManaNodes"), false)
    assert.equal(invalidationIds.includes("characterManaNodeAwakeLevels"), false)
    assert.equal(new Set(invalidationIds).size, invalidationIds.length)
    assert.equal(Object.isFrozen(result.invalidatedFactKeys), true)
    assert.equal(result.invalidatedFactKeys.every(Object.isFrozen), true)

    const repeated = settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        awakeMissionIds,
        evaluationTime,
    )
    assert.equal(
        repeated.invalidatedFactKeys.map(getFactKeyId).includes("awakeEligibility"),
        false,
    )
})

for (const routeKind of ["single", "multi"]) {
    test(`${routeKind} outer transaction rolls Awake progress stages rewards and unlock back`, () => {
        const playerId = createEligiblePlayer(`awake-${routeKind}-rollback`)
        const before = itemAmounts(playerId)
        assert.throws(
            () => db.transaction(() => {
                const settlement = settleAwakeBattleMissions({
                    playerId,
                    questAccomplished: true,
                    characterIds: [341005],
                    directlyChangedMissionIds: [],
                    evaluationTime,
                })
                assert.equal(settlement.missionInfo.length, 4)
                assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
                throw new Error(`injected ${routeKind} finish failure`)
            })(),
            new RegExp(`injected ${routeKind} finish failure`),
        )
        assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 9), {})
        assert.deepEqual(itemAmounts(playerId), before)
        assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
        assert.equal(db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_category_mission_stages
            WHERE player_id = ? AND category = 9
        `).get(playerId).count, 0)
    })
}

test("unaccomplished and empty battles return before Catalog Session or database access", () => {
    const originalPrepare = db.prepare
    const originalGetFact = MissionEvaluationSession.prototype.getFact
    db.prepare = () => { throw new Error("empty Awake candidates must not access the database") }
    MissionEvaluationSession.prototype.getFact = () => {
        throw new Error("empty Awake candidates must not create or access a Session")
    }
    try {
        for (const params of [
            { questAccomplished: false, characterIds: [341005] },
            { questAccomplished: true, characterIds: [] },
        ]) {
            assert.deepEqual(settleAwakeBattleMissions({
                playerId: 999999,
                directlyChangedMissionIds: [],
                evaluationTime,
                ...params,
            }), {
                missionInfo: [],
                itemList: {},
                characterList: [],
                equipmentList: [],
                degreeIds: [],
                passCardPoints: {},
            })
        }
    } finally {
        db.prepare = originalPrepare
        MissionEvaluationSession.prototype.getFact = originalGetFact
    }
})

test("single and multi production finish routes call the shared Awake battle seam inside finish writes", () => {
    const singleWrites = fs.readFileSync(
        path.join(__dirname, "../src/lib/quest/finish/single-settlement-writes.ts"),
        "utf8",
    )
    const singleOrchestrator = fs.readFileSync(
        path.join(__dirname, "../src/lib/quest/finish/single-orchestrator.ts"),
        "utf8",
    )
    const singleTransactionBody = singleWrites.indexOf("export function executeSingleSettlementWrites(")
    const singleSeamCall = singleWrites.indexOf("settleAwakeBattleMissions({", singleTransactionBody)
    const singleTransactionCall = singleOrchestrator.indexOf("runSingleFinishSettlementTransaction({")
    const singleSettleBinding = singleOrchestrator.indexOf(
        "settle: ({ activeQuest, player, questProgress }) => {",
        singleTransactionCall,
    )
    const singleWritesCall = singleOrchestrator.indexOf(
        "executeSingleSettlementWrites({",
        singleSettleBinding,
    )
    assert.equal(singleTransactionBody >= 0, true, "single settlement writes function")
    assert.equal(singleSeamCall > singleTransactionBody, true, "single shared Awake seam call")
    assert.equal(singleTransactionCall >= 0, true, "single transaction call")
    assert.equal(singleSettleBinding > singleTransactionCall, true, "single transaction callback")
    assert.equal(singleWritesCall > singleSettleBinding, true, "single writes inside transaction callback")

    const multiPath = "src/multi/settlement/orchestrator.ts"
    const multiSource = fs.readFileSync(path.join(__dirname, "..", multiPath), "utf8")
    const transactionBody = multiSource.indexOf("const executeFinishWrites = () => {")
    const seamCall = multiSource.indexOf("settleAwakeBattleMissions({", transactionBody)
    const transactionCall = multiSource.indexOf(
        "const writes = runMultiActiveQuestSettlementTransaction(",
        seamCall,
    )
    const settleBinding = multiSource.indexOf("executeFinishWrites,", transactionCall)
    assert.equal(transactionBody >= 0, true, `${multiPath} transaction body`)
    assert.equal(seamCall > transactionBody, true, `${multiPath} shared Awake seam call`)
    assert.equal(transactionCall > seamCall, true, `${multiPath} transaction call`)
    assert.equal(settleBinding >= transactionCall, true, `${multiPath} transaction callback`)
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
