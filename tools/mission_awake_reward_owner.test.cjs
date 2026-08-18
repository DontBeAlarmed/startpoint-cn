"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    AWAKE_CHARACTER_ID,
    AWAKE_ITEM_ID,
    AWAKE_MISSION_ID,
    awakeRewardTable,
} = require("./helpers/awake-reward-owner-fixture.cjs")
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-reward-owner-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    tableOverrides: { "mission_char_awake_reward.json": awakeRewardTable() },
})
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const {
    settleAwakeMissionCandidatesWithEvaluation,
} = require("../src/lib/mission/awake-settlement")
const {
    executeRewardGrantPlanInTransactionOwnerSync,
} = require("../src/lib/reward-grant/owner-executor")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2025-01-01T12:00:00.000Z")

function createEligiblePlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, AWAKE_CHARACTER_ID)
    const rarity = getCharacterDataSync(AWAKE_CHARACTER_ID).rarity
    updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, {
        exp: characterExpCaps[rarity][0],
    })
    insertPlayerCharacterManaNodesSync(
        playerId,
        AWAKE_CHARACTER_ID,
        Object.keys(getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1)).map(Number),
    )
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 1, 0, 0, 0, 0)
    `).run(playerId, AWAKE_CHARACTER_ID)
    return playerId
}

test("Awake category 9 standard rewards use the owner with mission definition sources", () => {
    const playerId = createEligiblePlayer("awake-owner")
    const before = getPlayerSync(playerId)
    let callbackCalls = 0
    let callbackSources

    const result = settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        [AWAKE_MISSION_ID],
        evaluationTime,
        undefined,
        {
            standardRewardGrant: (plan, knownPlayerBefore, playerUpdate) => {
                callbackCalls++
                callbackSources = plan.entries.map(entry => entry.source)
                return executeRewardGrantPlanInTransactionOwnerSync(
                    playerId,
                    plan,
                    knownPlayerBefore,
                    playerUpdate,
                )
            },
        },
    )

    const after = getPlayerSync(playerId)
    assert.equal(callbackCalls, 1)
    assert.deepEqual(callbackSources, [
        { kind: "mission", definitionId: 34100511, rewardIndex: 0 },
        { kind: "mission", definitionId: 34100511, rewardIndex: 1 },
        { kind: "mission", definitionId: 34100511, rewardIndex: 2 },
        { kind: "mission", definitionId: 34100511, rewardIndex: 3 },
    ])
    assert.equal(result.settlement.itemList[AWAKE_ITEM_ID], 2)
    assert.equal(getPlayerItemSync(playerId, AWAKE_ITEM_ID), 2)
    assert.equal(result.settlement.userInfo.free_mana, after.freeMana)
    assert.equal(after.freeMana, before.freeMana + 7)
    assert.equal(after.freeVmoney, before.freeVmoney + 13)
    assert.equal(after.expPool, before.expPool + 11)
})

test("Awake settlement without an owner keeps the legacy granter behavior", () => {
    const playerId = createEligiblePlayer("awake-legacy")
    const before = getPlayerSync(playerId)

    const result = settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        [AWAKE_MISSION_ID],
        evaluationTime,
    )

    const after = getPlayerSync(playerId)
    assert.equal(result.settlement.itemList[AWAKE_ITEM_ID], 2)
    assert.equal(getPlayerItemSync(playerId, AWAKE_ITEM_ID), 2)
    assert.equal(result.settlement.userInfo.free_mana, after.freeMana)
    assert.equal(after.freeMana, before.freeMana + 7)
    assert.equal(after.freeVmoney, before.freeVmoney + 13)
    assert.equal(after.expPool, before.expPool + 11)
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
