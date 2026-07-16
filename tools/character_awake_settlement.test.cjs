const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { getDb } = require("../out/data/db")
const { computeAwakeSummary, reconcileAwakeUnlocks, settleAwakeMissionRewards } = require("../out/lib/mission")
const { insertAccountSync } = require("../out/data/domains/account")
const { insertDefaultPlayerCharacterSync } = require("../out/data/domains/character")
const characterAwakeDomain = require("../out/data/domains/character_awake")
const { getPlayerCharacterAwakeUnlocksSync } = characterAwakeDomain
const { getPlayerItemSync } = require("../out/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../out/data/domains/mission")
const { insertDefaultPlayerSync } = require("../out/data/domains/player")
const { getAwakeMissionRewardStageDefinition } = require("../out/lib/mission/rewards")
const awakeRewardMaster = require("../assets/mission_char_awake_reward.json")

const db = getDb()
const idpId = `character-awake-settlement-test-${randomUUID()}`
const duplicateProgressIdpId = `${idpId}-duplicate-progress`
const unreceivedFinalStageRecoveryIdpId = `${idpId}-unreceived-final-stage-recovery`
const faultIdpId = `${idpId}-fault`

function assertNoCharacterRewardConflictsWithSpecialUnlock() {
    let specialRewardCount = 0
    for (const [missionId, stages] of Object.entries(awakeRewardMaster)) {
        for (const stage of Object.keys(stages)) {
            const definition = getAwakeMissionRewardStageDefinition(Number(missionId), Number(stage))
            if (!definition?.specialReward) continue
            specialRewardCount++
            assert.equal(
                definition.rewards.some(reward =>
                    reward.kind === 4
                    && reward.characterId === definition.specialReward.characterId
                ),
                false,
                `mission ${missionId} stage ${stage} has conflicting character and unlock entries`
            )
        }
    }
    assert.equal(specialRewardCount > 0, true)
}

function testDuplicateProgressUsesMaximum(playerId) {
    const itemAmountBefore = getPlayerItemSync(playerId, 13) ?? 0
    const settlement = settleAwakeMissionRewards(playerId, [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410051, progress: 0 },
    ])

    assert.deepEqual(settlement.missionInfo, [
        { mission_category_id: 9, mission_id: 3410051, mission_reward_id: 34100511 },
    ])
    assert.deepEqual(settlement.itemList, { 13: itemAmountBefore + 10 })
    const persistedMission = getPlayerCategoryMissionsSync(playerId, 9)[3410051]
    assert.equal(persistedMission.progress, 1)
    assert.equal(persistedMission.stages[1], true)
}

function testUnreceivedFinalStageRestoresMissingUnlock(playerId, progressList) {
    settleAwakeMissionRewards(playerId, progressList.slice(0, 3))
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    const itemAmountBefore = getPlayerItemSync(playerId, 16) ?? 0

    const settlement = settleAwakeMissionRewards(playerId, progressList)
    assert.deepEqual(settlement.missionInfo, [
        { mission_category_id: 9, mission_id: 3410054, mission_reward_id: 34100541 },
    ])
    assert.deepEqual(settlement.itemList, { 16: itemAmountBefore + 1 })
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
    assert.deepEqual(
        settlement.characterList.find(entry => entry.character_id === 341005)?.mana_board_awake,
        { 1: 1 }
    )

    const repeatedSettlement = settleAwakeMissionRewards(playerId, progressList)
    assert.deepEqual(repeatedSettlement.missionInfo, [])
    assert.deepEqual(repeatedSettlement.itemList, {})
    assert.deepEqual(repeatedSettlement.characterList, [])
    assert.equal(getPlayerItemSync(playerId, 16) ?? 0, itemAmountBefore + 1)
}

function testSpecialUnlockFailureRollsBackSettlement(playerId) {
    const missionId = 3410054
    const itemAmountBefore = getPlayerItemSync(playerId, 16) ?? 0
    const originalUpsert = characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync
    let reachedUnlockUpsert = false

    characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync = (...args) => {
        reachedUnlockUpsert = true
        const inTransactionMission = getPlayerCategoryMissionsSync(playerId, 9)[missionId]
        assert.equal(inTransactionMission.progress, 3)
        assert.equal(inTransactionMission.stages[1], true)
        assert.equal(getPlayerItemSync(playerId, 16), itemAmountBefore + 1)
        assert.equal(originalUpsert(...args), true)
        assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
        throw new Error("injected awake unlock upsert failure")
    }

    try {
        assert.throws(
            () => settleAwakeMissionRewards(playerId, [{ missionId, progress: 3 }]),
            /injected awake unlock upsert failure/
        )
    } finally {
        characterAwakeDomain.upsertPlayerCharacterAwakeUnlockSync = originalUpsert
    }

    assert.equal(reachedUnlockUpsert, true)
    assert.equal(getPlayerItemSync(playerId, 16) ?? 0, itemAmountBefore)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9 AND id = ?
    `).get(playerId, missionId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9 AND mission_id = ?
    `).get(playerId, missionId).count, 0)
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
}

db.exec("BEGIN")
try {
    assertNoCharacterRewardConflictsWithSpecialUnlock()

    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)

    db.prepare("DELETE FROM players_category_mission_stages WHERE player_id = ? AND category = 9").run(playerId)
    db.prepare("DELETE FROM players_category_missions WHERE player_id = ? AND category = 9").run(playerId)
    db.prepare("DELETE FROM players_character_awake_unlocks WHERE player_id = ?").run(playerId)
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 341005, 5, 0, 0, 0, 0)
        ON CONFLICT(player_id, character_id) DO UPDATE SET clear_count = 5
    `).run(playerId)

    const itemAmountsBefore = Object.fromEntries(
        [13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])
    )
    const reconciliation = reconcileAwakeUnlocks(playerId, [341005])
    assert.deepEqual(reconciliation.all.get("341005"), { 1: 1 })
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })

    const completedButUnreceived = computeAwakeSummary(playerId)
    const mewMissions = completedButUnreceived.activeMissionList
        .filter(mission => Math.floor(mission.mission_id / 10) === 341005)
    const mewStages = mewMissions.flatMap(mission => mission.stages)

    assert.equal(mewMissions.length, 4)
    assert.equal(mewStages.length, 4)
    assert.equal(mewStages.every(stage => stage.received === false), true)
    assert.deepEqual(completedButUnreceived.manaBoardAwakeMap.get("341005"), { 1: 1 })
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        itemAmountsBefore
    )
    const progressList = [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410052, progress: 5 },
        { missionId: 3410053, progress: 5 },
        { missionId: 3410054, progress: 3 },
    ]

    const firstSettlement = settleAwakeMissionRewards(playerId, progressList)
    assert.deepEqual(firstSettlement.missionInfo, [
        { mission_category_id: 9, mission_id: 3410051, mission_reward_id: 34100511 },
        { mission_category_id: 9, mission_id: 3410052, mission_reward_id: 34100521 },
        { mission_category_id: 9, mission_id: 3410053, mission_reward_id: 34100531 },
        { mission_category_id: 9, mission_id: 3410054, mission_reward_id: 34100541 },
    ])
    assert.deepEqual(firstSettlement.itemList, {
        13: itemAmountsBefore[13] + 10,
        14: itemAmountsBefore[14] + 5,
        15: itemAmountsBefore[15] + 3,
        16: itemAmountsBefore[16] + 1,
    })
    assert.deepEqual(firstSettlement.characterList, [])

    const persistedMissions = getPlayerCategoryMissionsSync(playerId, 9)
    assert.equal(progressList.every(entry => persistedMissions[entry.missionId].stages[1] === true), true)
    const settledSummary = computeAwakeSummary(playerId)
    assert.deepEqual(settledSummary.manaBoardAwakeMap.get("341005"), { 1: 1 })

    const secondSettlement = settleAwakeMissionRewards(playerId, progressList)
    assert.deepEqual(secondSettlement.missionInfo, [])
    assert.deepEqual(secondSettlement.itemList, {})
    assert.deepEqual(secondSettlement.characterList, [])
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        firstSettlement.itemList
    )

    const duplicateProgressAccount = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: duplicateProgressIdpId,
        status: "normal",
    })
    const duplicateProgressPlayerId = insertDefaultPlayerSync(duplicateProgressAccount.id).id
    testDuplicateProgressUsesMaximum(duplicateProgressPlayerId)

    const unreceivedFinalStageRecoveryAccount = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: unreceivedFinalStageRecoveryIdpId,
        status: "normal",
    })
    const unreceivedFinalStageRecoveryPlayerId = insertDefaultPlayerSync(unreceivedFinalStageRecoveryAccount.id).id
    insertDefaultPlayerCharacterSync(unreceivedFinalStageRecoveryPlayerId, 341005)
    db.prepare("DELETE FROM players_category_mission_stages WHERE player_id = ? AND category = 9")
        .run(unreceivedFinalStageRecoveryPlayerId)
    db.prepare("DELETE FROM players_category_missions WHERE player_id = ? AND category = 9")
        .run(unreceivedFinalStageRecoveryPlayerId)
    db.prepare("DELETE FROM players_character_awake_unlocks WHERE player_id = ?")
        .run(unreceivedFinalStageRecoveryPlayerId)
    testUnreceivedFinalStageRestoresMissingUnlock(unreceivedFinalStageRecoveryPlayerId, progressList)

    const faultAccount = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: faultIdpId,
        status: "normal",
    })
    const faultPlayerId = insertDefaultPlayerSync(faultAccount.id).id
    insertDefaultPlayerCharacterSync(faultPlayerId, 341005)
    db.prepare("DELETE FROM players_category_mission_stages WHERE player_id = ? AND category = 9").run(faultPlayerId)
    db.prepare("DELETE FROM players_category_missions WHERE player_id = ? AND category = 9").run(faultPlayerId)
    db.prepare("DELETE FROM players_character_awake_unlocks WHERE player_id = ?").run(faultPlayerId)
    testSpecialUnlockFailureRollsBackSettlement(faultPlayerId)

    const missionRouteSource = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/mission.ts"),
        "utf8"
    )
    const silentUpdateBlock = missionRouteSource.split('fastify.post("/update_mission_progress"')[1]
    assert.equal(silentUpdateBlock.includes("reconcileAwakeUnlockCharacterList"), true)
    assert.equal(silentUpdateBlock.includes("settleAwakeMissionRewards"), false)
    assert.equal(silentUpdateBlock.includes("computeAwakeSummary"), false)

    console.log("character awake settlement tests passed")
} finally {
    db.exec("ROLLBACK")
    assert.deepEqual(db.prepare(`
        SELECT idp_id
        FROM accounts
        WHERE idp_id IN (?, ?, ?, ?)
        ORDER BY idp_id
    `).all(idpId, duplicateProgressIdpId, unreceivedFinalStageRecoveryIdpId, faultIdpId), [])
}
