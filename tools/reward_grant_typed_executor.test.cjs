"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reward-grant-typed-executor-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerCollectedItemTotalSync, getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    RewardGrantContractValidationError,
    RewardGrantExecutionTransactionError,
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    executeRewardGrantExecutionPlanSync,
    executeRewardGrantExecutionPlanWithinTransactionSync,
} = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

const ITEM_ID = 930001
const EQUIPMENT_ID = 3010006
const CHARACTER_ID = 341005

let database
const sqlTrace = { active: false, statements: [] }

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
        idpId: label,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function knownPlayer(playerId) {
    const player = getPlayerSync(playerId)
    assert.ok(player)
    return {
        playerId,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("standalone typed execution returns owner after-state for every asset kind", () => {
    const playerId = createPlayer("typed-mixed")
    const before = getPlayerSync(playerId)
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: ITEM_ID, count: 2 },
        { type: RewardType.ELEMENT, id: ITEM_ID, count: 3 },
        { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 2 },
        { type: RewardType.CHARACTER, id: CHARACTER_ID },
        { type: RewardType.BEADS, count: 4 },
        { type: RewardType.MANA, count: 5 },
        { type: RewardType.EXP, count: 6 },
    ])

    const result = executeRewardGrantExecutionPlanSync(playerId, plan)

    assert.deepEqual(result.entries.map(entry => entry.index), [0, 1, 2, 3, 4, 5, 6])
    assert.deepEqual(result.assets.items, [{
        itemId: ITEM_ID,
        requestedAmount: 5,
        acceptedAmount: 5,
        overflowAmount: 0,
        beforeAmount: 0,
        afterAmount: 5,
    }])
    assert.equal(result.assets.characters[0].characterId, CHARACTER_ID)
    assert.equal(result.assets.characters[0].joined, true)
    assert.equal(result.assets.equipment[0].equipmentId, EQUIPMENT_ID)
    assert.equal(result.assets.equipment[0].requestedAmount, 2)
    assert.deepEqual(result.playerAfter, {
        playerId,
        freeMana: before.freeMana + 5,
        freeVmoney: before.freeVmoney + 4,
        expPool: before.expPool + 6,
    })
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), 5)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, ITEM_ID), 5)
    assert.equal(getPlayerCharacterSync(playerId, CHARACTER_ID).stack, 0)
    assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_ID).stack, 1)
    const after = getPlayerSync(playerId)
    assert.equal(after.totalManaObtained, before.totalManaObtained + 5)
})

test("typed standalone and within preserve transaction identities and one Player read", () => {
    const standalonePlayerId = createPlayer("typed-empty-standalone")
    const emptyPlan = createRewardGrantExecutionPlan([])
    const standalone = captureSql(() => executeRewardGrantExecutionPlanSync(
        standalonePlayerId,
        emptyPlan,
    ))
    assert.equal(standalone.result.playerAfter.playerId, standalonePlayerId)
    assert.equal(standalone.statements.filter(sql => /SELECT[\s\S]*FROM players\b/i.test(sql)).length, 1)
    assert.equal(standalone.statements.filter(sql => /players_items/i.test(sql)).length, 0)
    assert.equal(standalone.statements.filter(sql => /^\s*UPDATE players\b/i.test(sql)).length, 0)
    assert.deepEqual(
        standalone.statements.filter(sql => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)),
        ["BEGIN", "COMMIT"],
    )

    assert.throws(
        () => database.transaction(() => executeRewardGrantExecutionPlanSync(
            standalonePlayerId,
            emptyPlan,
        ))(),
        error => error instanceof RewardGrantExecutionTransactionError
            && error.reason === "ACTIVE_TRANSACTION_NOT_ALLOWED",
    )
    assert.throws(
        () => executeRewardGrantExecutionPlanWithinTransactionSync(standalonePlayerId, emptyPlan),
        error => error instanceof RewardGrantExecutionTransactionError
            && error.reason === "TRANSACTION_REQUIRED",
    )

    let within
    database.transaction(() => {
        within = captureSql(() => executeRewardGrantExecutionPlanWithinTransactionSync(
            standalonePlayerId,
            emptyPlan,
        ))
    })()
    assert.equal(within.statements.filter(sql => /SELECT[\s\S]*FROM players\b/i.test(sql)).length, 1)
    assert.equal(within.statements.filter(sql => /^\s*SAVEPOINT\b/i.test(sql)).length, 1)
    assert.equal(within.statements.filter(sql => /^\s*RELEASE\b/i.test(sql)).length, 1)
})

test("real repeated Character and Equipment entries preserve per-entry outcomes", () => {
    const duplicatePlayerId = createPlayer("typed-real-duplicate")
    const duplicateBefore = getPlayerCharacterSync(duplicatePlayerId, 1).stack
    let duplicateResult
    database.transaction(() => {
        duplicateResult = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            duplicatePlayerId,
            createRewardGrantExecutionPlan([
                { type: RewardType.ITEM, id: 14002, count: 2 },
                { type: RewardType.CHARACTER, id: 1 },
                { type: RewardType.CHARACTER, id: 1 },
            ]),
            knownPlayer(duplicatePlayerId),
        )
    })()
    assert.equal(duplicateResult.entries[1].outcome.compensationItem.beforeAmount, 2)
    assert.equal(duplicateResult.entries[1].outcome.compensationItem.afterAmount, 3)
    assert.equal(duplicateResult.entries[2].outcome.compensationItem.beforeAmount, 3)
    assert.equal(duplicateResult.entries[2].outcome.compensationItem.afterAmount, 4)
    assert.equal(duplicateResult.assets.items[0].requestedAmount, 4)
    assert.equal(getPlayerCharacterSync(duplicatePlayerId, 1).stack, duplicateBefore + 2)

    const firstPlayerId = createPlayer("typed-first-then-duplicate")
    const characterId = 341006
    const firstResult = executeRewardGrantExecutionPlanSync(
        firstPlayerId,
        createRewardGrantExecutionPlan([
            { type: RewardType.CHARACTER, id: characterId },
            { type: RewardType.CHARACTER, id: characterId },
        ]),
    )
    assert.equal(firstResult.entries[0].outcome.isNew, true)
    assert.equal(firstResult.entries[0].outcome.compensationItem, null)
    assert.equal(firstResult.entries[1].outcome.isNew, false)
    assert.ok(firstResult.entries[1].outcome.compensationItem)
    assert.equal(firstResult.assets.characters[0].joined, true)

    const equipmentPlayerId = createPlayer("typed-repeated-equipment")
    const equipmentResult = executeRewardGrantExecutionPlanSync(
        equipmentPlayerId,
        createRewardGrantExecutionPlan([
            { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
            { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 2 },
        ]),
    )
    assert.equal(equipmentResult.entries.length, 2)
    assert.equal(equipmentResult.assets.equipment[0].requestedAmount, 3)
    assert.equal(getPlayerEquipmentSync(equipmentPlayerId, EQUIPMENT_ID).stack, 2)
})

test("empty Currency and first Character plans do not activate Inventory", () => {
    const emptyPlayerId = createPlayer("typed-owner-empty")
    const emptyBefore = knownPlayer(emptyPlayerId)
    let emptyMeasured
    database.transaction(() => {
        emptyMeasured = captureSql(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            emptyPlayerId,
            createRewardGrantExecutionPlan([]),
            emptyBefore,
        ))
    })()
    assert.equal(emptyMeasured.statements.filter(sql => /players_items/i.test(sql)).length, 0)
    assert.equal(emptyMeasured.statements.filter(sql => /^\s*UPDATE players\b/i.test(sql)).length, 0)

    const currencyPlayerId = createPlayer("typed-owner-currency")
    let currencyMeasured
    database.transaction(() => {
        currencyMeasured = captureSql(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            currencyPlayerId,
            createRewardGrantExecutionPlan([{ type: RewardType.EXP, count: 2 }]),
            knownPlayer(currencyPlayerId),
        ))
    })()
    assert.equal(currencyMeasured.statements.filter(sql => /players_items/i.test(sql)).length, 0)
    assert.equal(currencyMeasured.statements.filter(sql => /^\s*UPDATE players\b/i.test(sql)).length, 1)

    const characterPlayerId = createPlayer("typed-owner-first-character")
    let characterMeasured
    database.transaction(() => {
        characterMeasured = captureSql(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            characterPlayerId,
            createRewardGrantExecutionPlan([
                { type: RewardType.CHARACTER, id: 341007 },
            ]),
            knownPlayer(characterPlayerId),
        ))
    })()
    assert.equal(characterMeasured.statements.filter(sql => /players_items/i.test(sql)).length, 0)
})

test("transaction-owner binds player identity and batches repeated Item and Currency grants", () => {
    const playerId = createPlayer("typed-owner")
    const before = knownPlayer(playerId)
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: ITEM_ID + 1, count: 1 },
        { type: RewardType.ITEM, id: ITEM_ID + 1, count: 2 },
        { type: RewardType.MANA, count: 3 },
        { type: RewardType.MANA, count: 4 },
    ])
    let measured
    database.transaction(() => {
        measured = captureSql(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            playerId,
            plan,
            before,
        ))
    })()

    assert.equal(measured.statements.filter(sql => /SELECT[\s\S]*FROM players\b/i.test(sql)).length, 0)
    assert.equal(measured.statements.filter(sql => /SELECT[\s\S]*FROM players_items\b/i.test(sql)).length, 1)
    assert.equal(measured.statements.filter(sql => /INSERT INTO players_items/i.test(sql)).length, 1)
    assert.equal(measured.statements.filter(sql => /INSERT INTO players_collected_items/i.test(sql)).length, 1)
    assert.equal(measured.statements.filter(sql => /^\s*UPDATE players\b/i.test(sql)).length, 1)
    assert.equal(measured.result.assets.items[0].requestedAmount, 3)
    assert.equal(measured.result.assets.currencies[0].requestedAmount, 7)

    assert.throws(() => database.transaction(() => (
        executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            playerId,
            plan,
            { ...before, playerId: playerId + 1 },
        )
    ))(), error => error instanceof RewardGrantContractValidationError
        && error.field === "playerId")
})
