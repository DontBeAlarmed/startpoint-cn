"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "task23c-reward-grants-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase, closeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerDegreeIdsSync } = require("../src/data/domains/degree")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerPassCardStateSync } = require("../src/data/domains/pass-card")
const {
    getPlayerCarnivalEventRecordsSync,
    getPlayerClaimedCarnivalRewardIdsSync,
    insertPlayerClaimedCarnivalRewardIdsSync,
    upsertPlayerCarnivalEventRecordSync,
} = require("../src/data/domains/carnivalEvent")
const { getCharacterDataSync } = require("../src/lib/assets")
const { givePlayerCharacterSync } = require("../src/lib/character")
const { MissionRewardGranter } = require("../src/lib/mission/grants")
const { grantCarnivalRewards } = require("../src/lib/carnival-rewards")
const { handleCarnivalEventFinish } = require("../src/lib/quest/finish/carnival-handler")
const { createSingleSettlementStandardRewardGrant } = require("../src/lib/quest/finish/single-standard-reward-callbacks")
const { QuestCategory } = require("../src/lib/types")
const { executeRewardGrantPlanInTransactionOwnerSync } = require("../src/lib/reward-grant/owner-executor")
const { createRewardGrantPlan } = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

const sqlTrace = { active: false, statements: [] }

initializeDatabase({
    databaseFactory: databasePath => new BetterSqlite3(databasePath, {
        verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
    }),
})
const db = getDb()

function captureSql(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `task23c-${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function findCharacterId() {
    for (const rawId of [341003, 101001, 100001]) {
        if (getCharacterDataSync(rawId)) return rawId
    }
    throw new Error("No test character in the bundled catalog")
}

test("Carnival standard callback preserves standard response, degree domain write, and one mana total increment", () => {
    const playerId = createPlayer("carnival")
    const itemId = 990101
    const equipmentId = 5060042
    const degreeId = 61030
    const playerBefore = getPlayerSync(playerId)
    let callbackCalls = 0
    let callbackSources

    const result = db.transaction(() => grantCarnivalRewards(playerId, [{
        id: 1,
        eventId: 250604,
        score: 100,
        reasonId: 20001,
        rewards: [
            { kind: 0, id: itemId, amount: 2 },
            { kind: 1, id: equipmentId, amount: 1 },
            { kind: 1, id: equipmentId, amount: 2 },
            { kind: 2, amount: 7 },
            { kind: 3, amount: 11 },
            { kind: 4, amount: 13 },
            { kind: 7, id: degreeId, amount: 1 },
        ],
    }], {
        getPlayer: getPlayerSync,
        giveItem: givePlayerItemSync,
        giveEquipment: require("../src/lib/equipment").givePlayerEquipmentSync,
        giveDegree: require("../src/data/domains/degree").givePlayerDegreeSync,
        updatePlayer: updatePlayerSync,
        standardRewardGrant: (pid, plan, knownPlayerBefore) => {
            callbackCalls++
            callbackSources = plan.entries.map(entry => entry.source)
            return executeRewardGrantPlanInTransactionOwnerSync(pid, plan, knownPlayerBefore)
        },
    }))()

    const playerAfter = getPlayerSync(playerId)
    assert.equal(callbackCalls, 1)
    assert.deepEqual(callbackSources, [
        { kind: "carnival", definitionId: 1, rewardIndex: 0 },
        { kind: "carnival", definitionId: 1, rewardIndex: 1 },
        { kind: "carnival", definitionId: 1, rewardIndex: 2 },
        { kind: "carnival", definitionId: 1, rewardIndex: 3 },
        { kind: "carnival", definitionId: 1, rewardIndex: 4 },
        { kind: "carnival", definitionId: 1, rewardIndex: 5 },
    ])
    assert.deepEqual(result, {
        user_info: { free_vmoney: 7, free_mana: 11, exp_pool: 13 },
        item_list: { [itemId]: 2 },
        equipment_list: [{
            equipment_id: equipmentId,
            protection: false,
            level: 1,
            enhancement_level: 0,
            stack: 2,
        }],
        new_degree_ids: [degreeId],
    })
    assert.equal(getPlayerItemSync(playerId, itemId), 2)
    assert.equal(getPlayerEquipmentSync(playerId, equipmentId).stack, 2)
    assert.deepEqual(getPlayerDegreeIdsSync(playerId), [degreeId])
    assert.equal(playerAfter.freeVmoney, playerBefore.freeVmoney + 7)
    assert.equal(playerAfter.freeMana, playerBefore.freeMana + 11)
    assert.equal(playerAfter.expPool, playerBefore.expPool + 13)
    assert.equal(playerAfter.totalManaObtained, playerBefore.totalManaObtained + 11)
})

test("reused Carnival callback rejects another player before any reward or domain write", () => {
    const ownerPlayerId = createPlayer("carnival-callback-owner")
    const targetPlayerId = createPlayer("carnival-callback-target")
    const itemId = 990105
    const degreeId = 61050
    const ownerBefore = getPlayerSync(ownerPlayerId)
    const targetBefore = getPlayerSync(targetPlayerId)
    let ownerRewardState = {
        freeMana: ownerBefore.freeMana,
        freeVmoney: ownerBefore.freeVmoney,
        expPool: ownerBefore.expPool,
    }
    const standardRewardGrant = createSingleSettlementStandardRewardGrant(
        ownerPlayerId,
        state => { ownerRewardState = state },
    )

    assert.throws(() => handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 1,
        questData: { eventId: 250604, folderId: 1, difficultyScore: 100, timeLimitMs: 100 },
        clearTime: 0,
        party: {
            characters: [{ id: 101 }, null, null],
            unison_characters: [null, null, null],
        },
        playerId: targetPlayerId,
        getRecordsFn: getPlayerCarnivalEventRecordsSync,
        upsertFn: upsertPlayerCarnivalEventRecordSync,
        getRewardDefinitionsFn: () => [{
            id: 92001,
            eventId: 250604,
            score: 100,
            reasonId: 20001,
            rewards: [
                { kind: 0, id: itemId, amount: 4 },
                { kind: 7, id: degreeId, amount: 1 },
            ],
        }],
        getClaimedRewardIdsFn: getPlayerClaimedCarnivalRewardIdsSync,
        grantRewardsFn: (pid, definitions) => grantCarnivalRewards(pid, definitions, {
            getPlayer: getPlayerSync,
            giveItem: givePlayerItemSync,
            giveEquipment: require("../src/lib/equipment").givePlayerEquipmentSync,
            giveDegree: require("../src/data/domains/degree").givePlayerDegreeSync,
            updatePlayer: updatePlayerSync,
            standardRewardGrant: standardRewardGrant.forCarnival,
        }),
        claimRewardIdsFn: insertPlayerClaimedCarnivalRewardIdsSync,
        transactionFn: operation => db.transaction(operation)(),
    }), error => error?.name === "SingleSettlementRewardTargetMismatchError"
        && /target player/i.test(error.message))

    assert.deepEqual(getPlayerSync(ownerPlayerId), ownerBefore)
    assert.deepEqual(getPlayerSync(targetPlayerId), targetBefore)
    assert.deepEqual(ownerRewardState, {
        freeMana: ownerBefore.freeMana,
        freeVmoney: ownerBefore.freeVmoney,
        expPool: ownerBefore.expPool,
    })
    assert.equal(getPlayerItemSync(ownerPlayerId, itemId), null)
    assert.equal(getPlayerItemSync(targetPlayerId, itemId), null)
    assert.deepEqual(getPlayerDegreeIdsSync(ownerPlayerId), [])
    assert.deepEqual(getPlayerDegreeIdsSync(targetPlayerId), [])
    assert.deepEqual(getPlayerCarnivalEventRecordsSync(ownerPlayerId, 250604), [])
    assert.deepEqual(getPlayerCarnivalEventRecordsSync(targetPlayerId, 250604), [])
    assert.deepEqual([...getPlayerClaimedCarnivalRewardIdsSync(ownerPlayerId, 250604)], [])
    assert.deepEqual([...getPlayerClaimedCarnivalRewardIdsSync(targetPlayerId, 250604)], [])
})

function runMismatchedCarnivalFinish(rewards) {
    const ownerPlayerId = createPlayer("carnival-hook-owner")
    const targetPlayerId = createPlayer("carnival-hook-target")
    const standardRewardGrant = createSingleSettlementStandardRewardGrant(ownerPlayerId, () => {})
    const calls = { upsert: 0, degree: 0, claim: 0 }
    const itemId = 990106
    const beforeOwner = getPlayerSync(ownerPlayerId)

    assert.throws(() => handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 1,
        questData: { eventId: 250604, folderId: 1, difficultyScore: 100, timeLimitMs: 100 },
        clearTime: 0,
        party: {
            characters: [{ id: 101 }, null, null],
            unison_characters: [null, null, null],
        },
        playerId: targetPlayerId,
        getRecordsFn: getPlayerCarnivalEventRecordsSync,
        upsertFn: (...args) => {
            calls.upsert++
            return upsertPlayerCarnivalEventRecordSync(...args)
        },
        getRewardDefinitionsFn: () => [{
            id: 92002,
            eventId: 250604,
            score: 100,
            reasonId: 20001,
            rewards: rewards(itemId),
        }],
        getClaimedRewardIdsFn: getPlayerClaimedCarnivalRewardIdsSync,
        grantRewardsFn: (pid, definitions) => grantCarnivalRewards(pid, definitions, {
            getPlayer: getPlayerSync,
            giveItem: givePlayerItemSync,
            giveEquipment: require("../src/lib/equipment").givePlayerEquipmentSync,
            giveDegree: (id, degreeId) => {
                calls.degree++
                return require("../src/data/domains/degree").givePlayerDegreeSync(id, degreeId)
            },
            updatePlayer: updatePlayerSync,
            standardRewardGrant: standardRewardGrant.forCarnival,
        }),
        claimRewardIdsFn: (pid, eventId, rewardIds) => {
            calls.claim++
            return insertPlayerClaimedCarnivalRewardIdsSync(pid, eventId, rewardIds)
        },
        assertTargetPlayerFn: standardRewardGrant.assertTargetPlayer,
        transactionFn: operation => db.transaction(operation)(),
    }), error => error?.name === "SingleSettlementRewardTargetMismatchError")

    return {
        calls,
        owner: getPlayerSync(ownerPlayerId),
        targetRecords: getPlayerCarnivalEventRecordsSync(targetPlayerId, 250604),
        targetClaims: getPlayerClaimedCarnivalRewardIdsSync(targetPlayerId, 250604),
        targetItem: getPlayerItemSync(targetPlayerId, itemId),
        targetDegrees: getPlayerDegreeIdsSync(targetPlayerId),
        ownerBefore: beforeOwner,
    }
}

test("Carnival degree-only callback reuse rejects before record, degree, or claim writes", () => {
    const result = runMismatchedCarnivalFinish(itemId => [
        { kind: 7, id: 61051, amount: 1 },
    ])

    assert.deepEqual(result.calls, { upsert: 0, degree: 0, claim: 0 })
    assert.deepEqual(result.targetRecords, [])
    assert.deepEqual([...result.targetClaims], [])
    assert.equal(result.targetItem, null)
    assert.deepEqual(result.targetDegrees, [])
    assert.deepEqual(result.owner, result.ownerBefore)
})

test("Carnival standard-plus-degree callback reuse rejects before record, degree, or claim writes", () => {
    const result = runMismatchedCarnivalFinish(itemId => [
        { kind: 0, id: itemId, amount: 4 },
        { kind: 7, id: 61052, amount: 1 },
    ])

    assert.deepEqual(result.calls, { upsert: 0, degree: 0, claim: 0 })
    assert.deepEqual(result.targetRecords, [])
    assert.deepEqual([...result.targetClaims], [])
    assert.equal(result.targetItem, null)
    assert.deepEqual(result.targetDegrees, [])
    assert.deepEqual(result.owner, result.ownerBefore)
})

test("Mission standard callback preserves mixed domain rewards, duplicate compensation, and response privacy", () => {
    const playerId = createPlayer("mission")
    const itemId = 990102
    const equipmentId = 5060042
    const characterId = findCharacterId()
    const degreeId = 61020
    assert.ok(givePlayerCharacterSync(playerId, characterId))
    const playerBefore = getPlayerSync(playerId)
    let callbackCalls = 0
    let callbackSources

    const granter = new MissionRewardGranter(playerId, playerBefore)
    db.transaction(() => {
        granter.grant([
            { kind: 0, amount: 7 },
            { kind: 1, itemId, amount: 2 },
            { kind: 1, itemId, amount: 3 },
            { kind: 2, equipmentId, amount: 1 },
            { kind: 2, equipmentId, amount: 2 },
            { kind: 3, amount: 11 },
            { kind: 4, characterId, amount: 2 },
            { kind: 5, amount: 13 },
            { kind: 6, degreeId, amount: 1 },
            { kind: 7, amount: 10 },
        ], {
            definitionId: 88001,
            passCardEventId: 3,
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
        })
        granter.persistPlayer()
    })()

    const playerAfter = getPlayerSync(playerId)
    assert.equal(callbackCalls, 1)
    assert.deepEqual(callbackSources, [
        { kind: "mission", definitionId: 88001, rewardIndex: 0 },
        { kind: "mission", definitionId: 88001, rewardIndex: 1 },
        { kind: "mission", definitionId: 88001, rewardIndex: 2 },
        { kind: "mission", definitionId: 88001, rewardIndex: 3 },
        { kind: "mission", definitionId: 88001, rewardIndex: 4 },
        { kind: "mission", definitionId: 88001, rewardIndex: 5 },
        { kind: "mission", definitionId: 88001, rewardIndex: 6 },
        { kind: "mission", definitionId: 88001, rewardIndex: 6 },
        { kind: "mission", definitionId: 88001, rewardIndex: 7 },
    ])
    assert.equal(getPlayerItemSync(playerId, itemId), 5)
    assert.equal(granter.itemList[String(itemId)], 5)
    assert.equal(getPlayerEquipmentSync(playerId, equipmentId).stack, 2)
    assert.equal(granter.equipmentList.length, 1)
    assert.equal(granter.characterList.length, 1)
    assert.equal(Object.hasOwn(granter.characterList[0], "isNew"), false)
    assert.deepEqual(granter.degreeList, [degreeId])
    assert.equal(getPlayerPassCardStateSync(playerId, 3).point, 10)
    assert.equal(playerAfter.freeVmoney, playerBefore.freeVmoney + 7)
    assert.equal(playerAfter.freeMana, playerBefore.freeMana + 11)
    assert.equal(playerAfter.expPool, playerBefore.expPool + 13)
    assert.equal(playerAfter.totalManaObtained, playerBefore.totalManaObtained + 11)
    assert.equal(granter.getUserInfo().free_mana, playerAfter.freeMana)
})

test("RewardGrant owner currency admission does not increase writer SQL", () => {
    const itemId = 990104
    const equipmentId = 5060042
    const rewards = [
        { kind: 1, itemId, amount: 2 },
        { kind: 2, equipmentId, amount: 1 },
        { kind: 0, amount: 7 },
        { kind: 3, amount: 11 },
        { kind: 5, amount: 13 },
    ]
    const legacyPlayerId = createPlayer("mission-sql-legacy")
    const ownerPlayerId = createPlayer("mission-sql-owner")
    let ownerCallbackCalls = 0

    const legacy = captureSql(() => db.transaction(() => {
        const granter = new MissionRewardGranter(legacyPlayerId, getPlayerSync(legacyPlayerId))
        granter.grant(rewards.slice(0, 2))
        granter.grant(rewards.slice(2))
        granter.persistPlayer()
    })())
    const owner = captureSql(() => db.transaction(() => {
        const granter = new MissionRewardGranter(ownerPlayerId, getPlayerSync(ownerPlayerId))
        const context = {
            standardRewardGrant: (plan, known, playerUpdate) => {
                ownerCallbackCalls++
                return executeRewardGrantPlanInTransactionOwnerSync(
                    ownerPlayerId,
                    plan,
                    known,
                    playerUpdate,
                )
            },
        }
        granter.grant(rewards.slice(0, 2), context)
        granter.grant(rewards.slice(2), context)
        granter.persistPlayer()
    })())
    const writeCount = statements => statements.filter(sql => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)).length
    assert.ok(owner.statements.length <= legacy.statements.length, {
        legacy: legacy.statements,
        owner: owner.statements,
    })
    assert.equal(ownerCallbackCalls, 1)
    assert.ok(writeCount(owner.statements) <= writeCount(legacy.statements), {
        legacy: legacy.statements,
        owner: owner.statements,
    })
})

test("single outer transaction rolls back Carnival and Mission standard plus domain writes", () => {
    const carnivalPlayerId = createPlayer("carnival-rollback")
    const missionPlayerId = createPlayer("mission-rollback")
    const itemId = 990103
    const degreeId = 61040
    const makePlan = (source, reward) => createRewardGrantPlan([{ source, reward }])
    let callbackCalls = 0

    assert.throws(() => db.transaction(() => {
        grantCarnivalRewards(carnivalPlayerId, [{
            id: 2,
            eventId: 250604,
            score: 100,
            reasonId: 20001,
            rewards: [
                { kind: 0, id: itemId, amount: 4 },
                { kind: 7, id: degreeId, amount: 1 },
            ],
        }], {
            getPlayer: getPlayerSync,
            giveItem: givePlayerItemSync,
            giveEquipment: require("../src/lib/equipment").givePlayerEquipmentSync,
            giveDegree: require("../src/data/domains/degree").givePlayerDegreeSync,
            updatePlayer: updatePlayerSync,
            standardRewardGrant: (pid, plan, known) => (
                (callbackCalls++, executeRewardGrantPlanInTransactionOwnerSync(pid, plan, known))
            ),
        })
        const granter = new MissionRewardGranter(missionPlayerId, getPlayerSync(missionPlayerId))
        granter.grant([
            { kind: 1, itemId, amount: 3 },
            { kind: 6, degreeId, amount: 1 },
        ], {
            standardRewardGrant: (plan, known, playerUpdate) => (
                (callbackCalls++, executeRewardGrantPlanInTransactionOwnerSync(
                    missionPlayerId,
                    plan,
                    known,
                    playerUpdate,
                ))
            ),
        })
        granter.persistPlayer()
        throw new Error("task23c outer rollback")
    })(), /task23c outer rollback/)

    assert.equal(callbackCalls, 2)
    assert.equal(getPlayerItemSync(carnivalPlayerId, itemId), null)
    assert.equal(getPlayerItemSync(missionPlayerId, itemId), null)
    assert.deepEqual(getPlayerDegreeIdsSync(carnivalPlayerId), [])
    assert.deepEqual(getPlayerDegreeIdsSync(missionPlayerId), [])
})

test.after(() => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
