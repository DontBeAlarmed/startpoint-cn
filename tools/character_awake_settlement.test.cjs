const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { getDb } = require("../out/data/db")
const { computeAwakeSummary, reconcileAwakeUnlocks, settleAwakeMissionRewards } = require("../out/lib/mission")
const { insertAccountSync } = require("../out/data/domains/account")
const { insertDefaultPlayerCharacterSync } = require("../out/data/domains/character")
const { getPlayerItemSync } = require("../out/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../out/data/domains/mission")
const { insertDefaultPlayerSync } = require("../out/data/domains/player")

const db = getDb()
const idpId = `character-awake-settlement-test-${randomUUID()}`

db.exec("BEGIN")
try {
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
    assert.deepEqual(
        firstSettlement.characterList.find(entry => entry.character_id === 341005)?.mana_board_awake,
        { 1: 1 }
    )

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

    const missionRouteSource = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/mission.ts"),
        "utf8"
    )
    const silentUpdateBlock = missionRouteSource.split('fastify.post("/update_mission_progress"')[1]
    assert.equal(silentUpdateBlock.includes("computeAwakeSummary"), false)
    assert.equal(silentUpdateBlock.includes('"character_list"'), false)

    console.log("character awake settlement tests passed")
} finally {
    db.exec("ROLLBACK")
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM accounts
        WHERE idp_id = ?
    `).get(idpId).count, 0)
}
