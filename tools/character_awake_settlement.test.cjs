require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const { after } = require("node:test")
const os = require("node:os")
const path = require("node:path")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const previousContentSnapshot = productionContentSnapshotProvider.snapshot
const restoreBundledCharacterSnapshot = installBundledGameplaySnapshot()
function restoreBundledCharacterSnapshotOnExit() {
    restoreBundledCharacterSnapshot()
}
process.once("exit", restoreBundledCharacterSnapshotOnExit)
after(() => {
    process.removeListener("exit", restoreBundledCharacterSnapshotOnExit)
    restoreBundledCharacterSnapshot()
    restoreBundledCharacterSnapshot()
    assert.strictEqual(productionContentSnapshotProvider.snapshot, previousContentSnapshot)
})
const bundledCharacterSnapshot = productionContentSnapshotProvider.get()
const bundledCharacterTable = bundledCharacterSnapshot.repository.table("character.json")
assert.equal(Object.isFrozen(bundledCharacterSnapshot), true)
assert.equal(Object.isFrozen(bundledCharacterTable), true)
assert.equal(Object.isFrozen(bundledCharacterTable["341005"]), true)
assert.strictEqual(
    bundledCharacterSnapshot.repository.table("character.json"),
    bundledCharacterTable
)
assert.throws(
    () => bundledCharacterSnapshot.repository.table("gacha.json"),
    /unexpected gameplay table gacha\.json/
)

function testTopLevelFailureRestoresBundledCharacterSnapshot() {
    const markerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-snapshot-restore-"))
    const markerPath = path.join(markerDirectory, "restored")
    const childSource = `
        require("ts-node/register/transpile-only")
        const assert = require("node:assert/strict")
        const fs = require("node:fs")
        const {
            productionContentSnapshotProvider,
        } = require(process.env.CONTENT_SNAPSHOT_RUNTIME_PATH)
        const {
            installBundledGameplaySnapshot,
        } = require(process.env.BUNDLED_CHARACTER_HELPER_PATH)

        const previousSnapshot = productionContentSnapshotProvider.snapshot
        const restore = installBundledGameplaySnapshot({
            onRestore() {
                assert.strictEqual(productionContentSnapshotProvider.snapshot, previousSnapshot)
                fs.writeFileSync(process.env.RESTORE_MARKER_PATH, "restored")
            },
        })
        process.once("exit", restore)
        throw new Error("synthetic top-level awake fixture failure")
    `
    const result = spawnSync(process.execPath, ["-e", childSource], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        env: {
            ...process.env,
            BUNDLED_CHARACTER_HELPER_PATH: path.join(
                __dirname,
                "helpers/install-bundled-gameplay-snapshot.cjs"
            ),
            CONTENT_SNAPSHOT_RUNTIME_PATH: path.join(
                __dirname,
                "../src/content/runtime/content-snapshot"
            ),
            RESTORE_MARKER_PATH: markerPath,
        },
    })

    try {
        assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
        assert.equal(result.signal, null)
        assert.match(result.stderr, /synthetic top-level awake fixture failure/)
        assert.equal(fs.existsSync(markerPath), true, "exit fallback must invoke restore")
        assert.equal(fs.readFileSync(markerPath, "utf8"), "restored")
    } finally {
        fs.rmSync(markerDirectory, { recursive: true, force: true })
    }
}

testTopLevelFailureRestoresBundledCharacterSnapshot()

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-settlement-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.DATA_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanupDatabase)

const { getDb } = require("../src/data/db")
const {
    computeAwakeSummary,
    getAwakeBattleMissionIds,
    reconcileAwakeUnlocks,
    settleAwakeMissionCandidates,
    settleAwakeMissionRewards,
} = require("../src/lib/mission")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const characterAwakeDomain = require("../src/data/domains/character_awake")
const { getPlayerCharacterAwakeUnlocksSync } = characterAwakeDomain
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const missionDomain = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { getAwakeMissionRewardStageDefinition } = require("../src/lib/mission/rewards")
const awakeRewardMaster = require("../assets/mission_char_awake_reward.json")
const { AwakeComputer } = require("../src/lib/mission/computer-awake")

require("../src/data").initializeDatabase()
db = getDb()
const idpId = `character-awake-settlement-test-${randomUUID()}`
const duplicateProgressIdpId = `${idpId}-duplicate-progress`
const unreceivedFinalStageRecoveryIdpId = `${idpId}-unreceived-final-stage-recovery`
const faultIdpId = `${idpId}-fault`

function makeAwakeEligible(playerId) {
    const characterId = 341005
    const rarity = getCharacterDataSync(characterId).rarity
    updatePlayerCharacterSync(playerId, characterId, { exp: characterExpCaps[rarity][0] })
    insertPlayerCharacterManaNodesSync(
        playerId,
        characterId,
        Object.keys(getCharacterManaNodesSync(characterId, 1)).map(Number),
    )
}

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
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    assert.equal(settlement.characterList.some(entry => entry.character_id === 341005), false)

    const repeatedSettlement = settleAwakeMissionRewards(playerId, progressList)
    assert.deepEqual(repeatedSettlement.missionInfo, [])
    assert.deepEqual(repeatedSettlement.itemList, {})
    assert.deepEqual(repeatedSettlement.characterList, [])
    assert.equal(getPlayerItemSync(playerId, 16) ?? 0, itemAmountBefore + 1)
}

function testSpecialUnlockIsPublishedByGrowthOwner(playerId) {
    const missionId = 3410054
    const itemAmountBefore = getPlayerItemSync(playerId, 16) ?? 0
    const settlement = settleAwakeMissionRewards(playerId, [{ missionId, progress: 3 }])

    assert.equal(getPlayerItemSync(playerId, 16) ?? 0, itemAmountBefore + 1)
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    assert.equal(settlement.characterList.some(entry => entry.character_id === 341005), false)
}

db.exec("BEGIN")
try {
    assert.deepEqual(
        getAwakeBattleMissionIds(
            [341005, 1, 341005],
            [1110013, 1110013, 15000, 999999999, -1, 1.5],
        ),
        [11, 12, 13, 14, 1110013, 3410051, 3410052, 3410053, 3410054],
        "main/Sub、直接变化任务及同角色 ALL_COMPLETE 必须稳定去重，未知或跨分类 ID 必须 fail closed",
    )

    const originalBuildContext = AwakeComputer.buildContext
    const originalGetPlayerCategoryMissionsSync = missionDomain.getPlayerCategoryMissionsSync
    let buildContextCalls = 0
    AwakeComputer.buildContext = () => {
        buildContextCalls++
        throw new Error("empty candidates must not build awake context")
    }
    missionDomain.getPlayerCategoryMissionsSync = () => {
        throw new Error("empty candidates must not read mission progress")
    }
    try {
        assert.deepEqual(
            settleAwakeMissionCandidates(123456, [], new Date("2024-08-14T12:00:00.000Z")),
            {
                missionInfo: [],
                itemList: {},
                characterList: [],
                equipmentList: [],
                degreeIds: [],
                passCardPoints: {},
            },
        )
        assert.equal(buildContextCalls, 0)
    } finally {
        AwakeComputer.buildContext = originalBuildContext
        missionDomain.getPlayerCategoryMissionsSync = originalGetPlayerCategoryMissionsSync
    }

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
    makeAwakeEligible(playerId)

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
    insertDefaultPlayerCharacterSync(duplicateProgressPlayerId, 341005)
    makeAwakeEligible(duplicateProgressPlayerId)
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
    makeAwakeEligible(unreceivedFinalStageRecoveryPlayerId)
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
    makeAwakeEligible(faultPlayerId)
    db.prepare("DELETE FROM players_category_mission_stages WHERE player_id = ? AND category = 9").run(faultPlayerId)
    db.prepare("DELETE FROM players_category_missions WHERE player_id = ? AND category = 9").run(faultPlayerId)
    db.prepare("DELETE FROM players_character_awake_unlocks WHERE player_id = ?").run(faultPlayerId)
    testSpecialUnlockIsPublishedByGrowthOwner(faultPlayerId)

    const missionRouteSource = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/mission.ts"),
        "utf8"
    )
    const silentUpdateBlock = missionRouteSource.split('fastify.post("/update_mission_progress"')[1]
    assert.equal(silentUpdateBlock.includes("publishCharacterGrowthOwnerStateBestEffort"), true)
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
cleanupDatabase()
process.removeListener("exit", cleanupDatabase)
