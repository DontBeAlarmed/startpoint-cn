"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reward-grant-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { givePlayerCharacterSync } = require("../src/lib/character")
const {
    createRewardGrantPlan,
    executeRewardGrantPlanSync,
    executeRewardGrantPlanWithinTransactionSync,
    RewardGrantExecutionError,
    RewardGrantPlanValidationError,
    RewardGrantPlayerNotFoundError,
    RewardGrantTransactionRequiredError,
} = require("../src/lib/reward-grant")
const {
    RewardGrantKnownPlayerValidationError,
} = require("../src/lib/reward-grant/executor")
const {
    executeRewardGrantPlanInTransactionOwnerInternalSync,
    executeRewardGrantPlanInTransactionOwnerSync,
} = require("../src/lib/reward-grant/owner-executor")
const { RewardType } = require("../src/lib/types/rewards")

const ITEM_ID = 910001
const ELEMENT_ITEM_ID = 910002
const AETHER_ITEM_ID = 910003
const EQUIPMENT_ID = 3010006
const CHARACTER_ID = 341005
const DUPLICATE_CHARACTER_ID = 1
const DUPLICATE_CHARACTER_ITEM_ID = 14002

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
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function playerState(playerId) {
    const player = getPlayerSync(playerId)
    return {
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
        totalManaObtained: player.totalManaObtained,
    }
}

function itemPlan(itemId, count, source = "item") {
    return createRewardGrantPlan([{
        source,
        reward: { type: RewardType.ITEM, id: itemId, count },
    }])
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

test("within-transaction execution rejects before reading or writing outside a transaction", () => {
    const playerId = createPlayer("requires-transaction")
    const before = playerState(playerId)

    assert.throws(
        () => executeRewardGrantPlanWithinTransactionSync(playerId, itemPlan(911001, 2)),
        RewardGrantTransactionRequiredError,
    )
    assert.equal(getPlayerItemSync(playerId, 911001), null)
    assert.deepEqual(playerState(playerId), before)
})

test("transaction-owner execution rejects outside its caller-owned transaction", () => {
    const playerId = createPlayer("owner-requires-transaction")
    const before = playerState(playerId)

    assert.throws(
        () => executeRewardGrantPlanInTransactionOwnerSync(
            playerId,
            itemPlan(911007, 2),
            { freeMana: before.freeMana, freeVmoney: before.freeVmoney, expPool: before.expPool },
        ),
        RewardGrantTransactionRequiredError,
    )
    assert.equal(getPlayerItemSync(playerId, 911007), null)
})

test("transaction-owner execution uses known currency state without player reads or transaction SQL", () => {
    const playerId = createPlayer("owner-known-player")
    const before = playerState(playerId)
    const knownPlayerBefore = {
        freeMana: before.freeMana,
        freeVmoney: before.freeVmoney,
        expPool: before.expPool,
    }
    const plan = createRewardGrantPlan([
        { source: { kind: "mana", index: 0 }, reward: { type: RewardType.MANA, count: 4 } },
        { source: { kind: "beads", index: 1 }, reward: { type: RewardType.BEADS, count: 5 } },
        { source: { kind: "exp", index: 2 }, reward: { type: RewardType.EXP, count: 6 } },
    ])
    let measured

    database.transaction(() => {
        measured = captureSql(() => executeRewardGrantPlanInTransactionOwnerSync(
            playerId,
            plan,
            knownPlayerBefore,
        ))
    })()

    assert.equal(
        measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(sql)).length,
        0,
    )
    assert.equal(
        measured.statements.filter(sql => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
    assert.deepEqual(measured.result.entries.map(entry => entry.source), [
        { kind: "mana", index: 0 },
        { kind: "beads", index: 1 },
        { kind: "exp", index: 2 },
    ])
    assert.deepEqual(measured.result.aggregate.user_info, {
        free_mana: 4,
        free_vmoney: 5,
        exp_pool: 6,
    })
    assert.deepEqual(measured.result.playerAfter, {
        freeMana: before.freeMana + 4,
        freeVmoney: before.freeVmoney + 5,
        expPool: before.expPool + 6,
    })
    assert.deepEqual(playerState(playerId), {
        freeMana: before.freeMana + 4,
        freeVmoney: before.freeVmoney + 5,
        expPool: before.expPool + 6,
        totalManaObtained: before.totalManaObtained + 4,
    })
})

test("character grants report ownership transition and RewardGrant reuses it without a pre-read", () => {
    const directPlayerId = createPlayer("character-ownership-fact")
    const first = givePlayerCharacterSync(directPlayerId, CHARACTER_ID)
    const second = givePlayerCharacterSync(directPlayerId, CHARACTER_ID)

    assert.equal(first.isNew, true)
    assert.equal(second.isNew, false)
    assert.equal(Object.hasOwn(first.character, "isNew"), false)
    assert.equal(Object.hasOwn(second.character, "isNew"), false)

    const playerId = createPlayer("owner-character-no-pre-read")
    const before = playerState(playerId)
    let measured
    database.transaction(() => {
        measured = captureSql(() => executeRewardGrantPlanInTransactionOwnerSync(
            playerId,
            createRewardGrantPlan([{
                source: "character",
                reward: { type: RewardType.CHARACTER, id: CHARACTER_ID },
            }]),
            before,
        ))
    })()

    const characterReads = measured.statements.filter(sql => (
        /^\s*SELECT/i.test(sql) && /\bFROM\s+players_characters\b/i.test(sql)
    ))
    assert.equal(characterReads.length, 1)
    assert.deepEqual(measured.result.entries[0].result.joined_character_id_list, [CHARACTER_ID])
})

test("transaction-owner execution snapshots known player fields once without leaking extras", () => {
    const playerId = createPlayer("owner-known-player-snapshot")
    const before = playerState(playerId)
    const reads = { freeMana: 0, freeVmoney: 0, expPool: 0, extra: 0 }
    const knownPlayerBefore = {
        get freeMana() {
            reads.freeMana++
            return reads.freeMana === 1 ? before.freeMana : -1
        },
        get freeVmoney() {
            reads.freeVmoney++
            return reads.freeVmoney === 1 ? before.freeVmoney : -1
        },
        get expPool() {
            reads.expPool++
            return reads.expPool === 1 ? before.expPool : -1
        },
        get extra() {
            reads.extra++
            return "must-not-leak"
        },
    }
    let result

    database.transaction(() => {
        result = executeRewardGrantPlanInTransactionOwnerSync(
            playerId,
            createRewardGrantPlan([]),
            knownPlayerBefore,
        )
    })()

    assert.deepEqual(reads, { freeMana: 1, freeVmoney: 1, expPool: 1, extra: 0 })
    assert.deepEqual(result.playerAfter, {
        freeMana: before.freeMana,
        freeVmoney: before.freeVmoney,
        expPool: before.expPool,
    })
    assert.deepEqual(Object.getPrototypeOf(result.playerAfter), Object.prototype)
})

test("transaction-owner execution rejects invalid known player fields before writes", () => {
    const playerId = createPlayer("owner-invalid-known-player")
    const itemId = 911013
    const before = playerState(playerId)
    const valid = {
        freeMana: before.freeMana,
        freeVmoney: before.freeVmoney,
        expPool: before.expPool,
    }
    const invalidValues = [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]

    for (const field of ["freeMana", "freeVmoney", "expPool"]) {
        for (const invalidValue of invalidValues) {
            const knownPlayerBefore = { ...valid, [field]: invalidValue }
            if (invalidValue === undefined) delete knownPlayerBefore[field]
            let caught
            database.transaction(() => {
                try {
                    executeRewardGrantPlanInTransactionOwnerSync(
                        playerId,
                        itemPlan(itemId, 1),
                        knownPlayerBefore,
                    )
                } catch (error) {
                    caught = error
                }
            })()

            assert.ok(
                typeof RewardGrantKnownPlayerValidationError === "function"
                    && caught instanceof RewardGrantKnownPlayerValidationError,
                `${field}:${String(invalidValue)}`,
            )
            assert.equal(caught.field, field)
            assert.equal(getPlayerItemSync(playerId, itemId), null)
        }
    }
})

test("transaction-owner execution rejects final expPool overflow before player write", () => {
    const playerId = createPlayer("owner-exp-overflow")
    const before = playerState(playerId)
    const statements = []
    sqlTrace.active = true
    try {
        assert.throws(
            () => database.transaction(() => executeRewardGrantPlanInTransactionOwnerSync(
                playerId,
                createRewardGrantPlan([{
                    source: { kind: "exp-overflow", index: 0 },
                    reward: { type: RewardType.EXP, count: 1 },
                }]),
                { freeMana: before.freeMana, freeVmoney: before.freeVmoney, expPool: Number.MAX_SAFE_INTEGER },
            ))(),
            error => error instanceof RewardGrantKnownPlayerValidationError
                && error.field === "expPool",
        )
    } finally {
        statements.push(...sqlTrace.statements)
        sqlTrace.active = false
    }

    assert.equal(statements.filter(sql => /^\s*UPDATE\s+players\b/i.test(sql)).length, 0)
    assert.deepEqual(playerState(playerId), before)
})

test("transaction-owner execution is absent from the public reward grant barrel", () => {
    assert.equal(
        require("../src/lib/reward-grant").executeRewardGrantPlanInTransactionOwnerSync,
        undefined,
    )
})

test("transaction-owner execution normalizes forged plans before its first write", () => {
    const playerId = createPlayer("owner-forged-plan")
    const itemId = 911008
    const before = playerState(playerId)
    const forgedPlan = { entries: [
        { source: "valid", reward: { type: RewardType.ITEM, id: itemId, count: 2 } },
        { source: "invalid", reward: { type: 999, id: 1, count: 1 } },
    ] }
    let caught

    database.transaction(() => {
        try {
            executeRewardGrantPlanInTransactionOwnerSync(playerId, forgedPlan, before)
        } catch (error) {
            caught = error
        }
    })()

    assert.ok(caught instanceof RewardGrantPlanValidationError)
    assert.equal(getPlayerItemSync(playerId, itemId), null)
})

test("transaction-owner execution relies on propagated errors for whole outer rollback", () => {
    const playerId = createPlayer("owner-propagated-failure")
    const callerItemId = 911009
    const planItemId = 911012
    const before = playerState(playerId)
    const plan = createRewardGrantPlan([
        { source: "item", reward: { type: RewardType.ITEM, id: planItemId, count: 2 } },
        { source: "character", reward: { type: RewardType.CHARACTER, id: 999999996 } },
    ])

    assert.throws(database.transaction(() => {
        givePlayerItemSync(playerId, callerItemId, 1)
        executeRewardGrantPlanInTransactionOwnerSync(playerId, plan, before)
    }), RewardGrantExecutionError)
    assert.equal(getPlayerItemSync(playerId, callerItemId), null)
    assert.equal(getPlayerItemSync(playerId, planItemId), null)
})

test("rejects a forged plan before writes even when the caller catches and commits", () => {
    const playerId = createPlayer("forged-plan")
    const itemId = 911010
    const forgedPlan = {
        entries: [
            { source: "valid", reward: { type: RewardType.ITEM, id: itemId, count: 2 } },
            { source: "invalid", reward: { type: 999, id: 1, count: 1 } },
        ],
    }
    let caught

    database.transaction(() => {
        try {
            executeRewardGrantPlanWithinTransactionSync(playerId, forgedPlan)
        } catch (error) {
            caught = error
        }
    })()

    assert.deepEqual({
        errorName: caught?.constructor?.name,
        entryIndex: caught?.entryIndex,
        field: caught?.field,
        itemCount: getPlayerItemSync(playerId, itemId),
    }, {
        errorName: "RewardGrantPlanValidationError",
        entryIndex: 1,
        field: "type",
        itemCount: null,
    })
})

test("rejects malformed forged plan containers with typed errors", () => {
    const playerId = createPlayer("malformed-forged-plan")

    for (const plan of [null, {}, { entries: null }, { entries: {} }]) {
        let caught
        database.transaction(() => {
            try {
                executeRewardGrantPlanWithinTransactionSync(playerId, plan)
            } catch (error) {
                caught = error
            }
        })()
        assert.ok(caught instanceof RewardGrantPlanValidationError)
        assert.equal(caught.entryIndex, -1)
        assert.equal(caught.field, "entries")
    }
})

test("normalizes forged plan and entry getters from one snapshot", () => {
    const playerId = createPlayer("forged-plan-getters")
    const itemId = 911011
    const reads = { entries: 0, index: 0, source: 0, reward: 0 }
    const source = { mailId: 77 }
    const reward = { type: RewardType.ITEM, id: itemId, count: 1 }
    const entry = new Proxy({ source, reward }, {
        get(target, property, receiver) {
            if (property === "source" || property === "reward") reads[property]++
            return Reflect.get(target, property, receiver)
        },
    })
    const entries = new Proxy([entry], {
        get(target, property, receiver) {
            if (property === "0") reads.index++
            return Reflect.get(target, property, receiver)
        },
    })
    const forgedPlan = {
        get entries() {
            reads.entries++
            return entries
        },
    }

    const result = database.transaction(() =>
        executeRewardGrantPlanWithinTransactionSync(playerId, forgedPlan))()

    assert.deepEqual(reads, { entries: 1, index: 1, source: 1, reward: 1 })
    assert.equal(result.entries[0].source, source)
    assert.equal(result.aggregate.items[itemId], 1)
})

test("executes mixed rewards in order and returns compatible per-entry and aggregate results", () => {
    const playerId = createPlayer("mixed")
    const before = playerState(playerId)
    const sources = [
        { drawIndex: 0 },
        { drawIndex: 1 },
        { mailId: 2 },
        { mailId: 3 },
        { mailId: 4 },
        { mailId: 5 },
        { mailId: 6 },
        { mailId: 7 },
        { mailId: 8 },
    ]
    const plan = createRewardGrantPlan([
        { source: sources[0], reward: { type: RewardType.ITEM, id: ITEM_ID, count: 2 } },
        { source: sources[1], reward: { type: RewardType.ITEM, id: ITEM_ID, count: 3 } },
        { source: sources[2], reward: { type: RewardType.ELEMENT, id: ELEMENT_ITEM_ID, count: 1 } },
        { source: sources[3], reward: { type: RewardType.AETHER, id: AETHER_ITEM_ID, count: 4 } },
        { source: sources[4], reward: { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 2 } },
        { source: sources[5], reward: { type: RewardType.CHARACTER, id: CHARACTER_ID } },
        { source: sources[6], reward: { type: RewardType.BEADS, count: 7 } },
        { source: sources[7], reward: { type: RewardType.MANA, count: 11 } },
        { source: sources[8], reward: { type: RewardType.EXP, count: 13 } },
    ])

    const result = database.transaction(() =>
        executeRewardGrantPlanWithinTransactionSync(playerId, plan))()

    assert.deepEqual(result.entries.map(entry => entry.source), sources)
    assert.equal(Object.hasOwn(result.entries[0], "itemDeltas"), false)
    assert.equal(result.entries[0].result.items[ITEM_ID], 2)
    assert.equal(result.entries[1].result.items[ITEM_ID], 5)
    assert.deepEqual(result.entries[5].result.joined_character_id_list, [CHARACTER_ID])
    assert.equal(result.entries[6].result.user_info.free_vmoney, 7)
    assert.equal(result.entries[7].result.user_info.free_mana, 11)
    assert.equal(result.entries[8].result.user_info.exp_pool, 13)

    assert.deepEqual(result.aggregate.user_info, {
        free_mana: 11,
        free_vmoney: 7,
        exp_pool: 13,
    })
    assert.equal(result.aggregate.items[ITEM_ID], 5)
    assert.equal(result.aggregate.items[ELEMENT_ITEM_ID], 1)
    assert.equal(result.aggregate.items[AETHER_ITEM_ID], 4)
    assert.equal(result.aggregate.equipment_list.length, 1)
    assert.equal(result.aggregate.equipment_list[0].equipment_id, EQUIPMENT_ID)
    assert.equal(result.aggregate.character_list.length, 1)
    assert.equal(result.aggregate.character_list[0].character_id, CHARACTER_ID)
    assert.deepEqual(result.aggregate.joined_character_id_list, [CHARACTER_ID])
    assert.deepEqual(result.playerAfter, {
        freeMana: before.freeMana + 11,
        freeVmoney: before.freeVmoney + 7,
        expPool: before.expPool + 13,
    })
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), 5)
    assert.equal(getPlayerEquipmentSync(playerId, EQUIPMENT_ID).stack, 1)
    assert.notEqual(getPlayerCharacterSync(playerId, CHARACTER_ID), null)
})

test("duplicate character compensation reports final item inventory post-state", () => {
    const playerId = createPlayer("duplicate-character")
    const plan = createRewardGrantPlan([
        { source: "first", reward: { type: RewardType.CHARACTER, id: DUPLICATE_CHARACTER_ID } },
        { source: "second", reward: { type: RewardType.CHARACTER, id: DUPLICATE_CHARACTER_ID } },
    ])

    const result = executeRewardGrantPlanSync(playerId, plan)

    assert.equal(result.entries[0].result.items[DUPLICATE_CHARACTER_ITEM_ID], 1)
    assert.equal(result.entries[1].result.items[DUPLICATE_CHARACTER_ITEM_ID], 2)
    assert.equal(Object.hasOwn(result.entries[0], "itemDeltas"), false)
    assert.equal(Object.hasOwn(result.entries[1], "itemDeltas"), false)
    assert.equal(result.aggregate.items[DUPLICATE_CHARACTER_ITEM_ID], 2)
    assert.equal(result.aggregate.character_list.length, 1)
    assert.deepEqual(result.aggregate.joined_character_id_list, [])
    assert.equal(getPlayerItemSync(playerId, DUPLICATE_CHARACTER_ITEM_ID), 2)
})

test("internal owner result retains compensation delta outside the public barrel", () => {
    const playerId = createPlayer("internal-character-detail")
    const before = playerState(playerId)
    const result = database.transaction(() => executeRewardGrantPlanInTransactionOwnerInternalSync(
        playerId,
        createRewardGrantPlan([{
            source: "character",
            reward: { type: RewardType.CHARACTER, id: DUPLICATE_CHARACTER_ID },
        }]),
        before,
    ))()

    assert.deepEqual(result.entries[0].itemDeltas, { [DUPLICATE_CHARACTER_ITEM_ID]: 1 })
    assert.equal(
        require("../src/lib/reward-grant").executeRewardGrantPlanInTransactionOwnerInternalSync,
        undefined,
    )
})

test("public transaction-owner result strips Score-only compensation metadata", () => {
    const playerId = createPlayer("public-owner-character-detail")
    const before = playerState(playerId)
    const result = database.transaction(() => executeRewardGrantPlanInTransactionOwnerSync(
        playerId,
        createRewardGrantPlan([{
            source: "character",
            reward: { type: RewardType.CHARACTER, id: DUPLICATE_CHARACTER_ID },
        }]),
        before,
    ))()

    assert.equal(Object.hasOwn(result.entries[0], "itemDeltas"), false)
    assert.equal(result.entries[0].result.items[DUPLICATE_CHARACTER_ITEM_ID], 1)
})

test("standalone execution owns one transaction and commits its result", () => {
    const playerId = createPlayer("standalone")

    const result = executeRewardGrantPlanSync(playerId, itemPlan(911002, 4, { mailId: 42 }))

    assert.equal(result.entries[0].source.mailId, 42)
    assert.equal(result.aggregate.items[911002], 4)
    assert.equal(getPlayerItemSync(playerId, 911002), 4)
})

test("within-transaction execution rolls its plan back when the caller catches a late character error", () => {
    const playerId = createPlayer("caught-character-failure")
    const planItemId = 911020
    const callerItemId = 911022
    const plan = createRewardGrantPlan([
        { source: "item", reward: { type: RewardType.ITEM, id: planItemId, count: 2 } },
        { source: "character", reward: { type: RewardType.CHARACTER, id: 999999997 } },
    ])
    let caught

    database.transaction(() => {
        try {
            executeRewardGrantPlanWithinTransactionSync(playerId, plan)
        } catch (error) {
            caught = error
        }
        givePlayerItemSync(playerId, callerItemId, 1)
    })()

    assert.ok(caught instanceof RewardGrantExecutionError)
    assert.equal(getPlayerItemSync(playerId, planItemId), null)
    assert.equal(getPlayerItemSync(playerId, callerItemId), 1)
})

test("within-transaction execution rolls its plan back when the caller catches a late database error", t => {
    const playerId = createPlayer("caught-database-failure")
    const firstPlanItemId = 911023
    const failingPlanItemId = 911024
    const callerItemId = 911025
    const plan = createRewardGrantPlan([
        { source: "first", reward: { type: RewardType.ITEM, id: firstPlanItemId, count: 2 } },
        { source: "failing", reward: { type: RewardType.ITEM, id: failingPlanItemId, count: 3 } },
    ])
    database.exec(`
        CREATE TRIGGER reject_reward_grant_late_item
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${failingPlanItemId}
        BEGIN SELECT RAISE(ABORT, 'forced reward grant failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_reward_grant_late_item"))
    let caught

    database.transaction(() => {
        try {
            executeRewardGrantPlanWithinTransactionSync(playerId, plan)
        } catch (error) {
            caught = error
        }
        givePlayerItemSync(playerId, callerItemId, 1)
    })()

    assert.match(caught.message, /forced reward grant failure/)
    assert.equal(getPlayerItemSync(playerId, firstPlanItemId), null)
    assert.equal(getPlayerItemSync(playerId, failingPlanItemId), null)
    assert.equal(getPlayerItemSync(playerId, callerItemId), 1)
})

test("a late execution failure rolls all earlier grants back", () => {
    const playerId = createPlayer("late-failure")
    const before = playerState(playerId)
    const plan = createRewardGrantPlan([
        { source: 0, reward: { type: RewardType.ITEM, id: 911003, count: 2 } },
        { source: 1, reward: { type: RewardType.MANA, count: 9 } },
        { source: 2, reward: { type: RewardType.CHARACTER, id: 999999999 } },
    ])

    assert.throws(() => executeRewardGrantPlanSync(playerId, plan), RewardGrantExecutionError)
    assert.equal(getPlayerItemSync(playerId, 911003), null)
    assert.deepEqual(playerState(playerId), before)
})

test("an outer transaction throw rolls a completed within-transaction grant back", () => {
    const playerId = createPlayer("caller-throw")
    const transaction = database.transaction(() => {
        executeRewardGrantPlanWithinTransactionSync(playerId, itemPlan(911004, 3))
        throw new Error("caller rejected settlement")
    })

    assert.throws(transaction, /caller rejected settlement/)
    assert.equal(getPlayerItemSync(playerId, 911004), null)
})

test("a caller can explicitly roll back a completed within-transaction grant", () => {
    const playerId = createPlayer("caller-rollback")

    database.exec("BEGIN")
    const result = executeRewardGrantPlanWithinTransactionSync(playerId, itemPlan(911005, 6))
    assert.equal(result.aggregate.items[911005], 6)
    database.exec("ROLLBACK")

    assert.equal(getPlayerItemSync(playerId, 911005), null)
})

test("unknown characters throw and persist no partial reward state", () => {
    const playerId = createPlayer("unknown-character")
    const before = playerState(playerId)
    const plan = createRewardGrantPlan([
        { source: "item", reward: { type: RewardType.ITEM, id: 911006, count: 1 } },
        { source: "character", reward: { type: RewardType.CHARACTER, id: 999999998 } },
    ])

    assert.throws(
        () => executeRewardGrantPlanSync(playerId, plan),
        error => error instanceof RewardGrantExecutionError
            && error.entryIndex === 1
            && error.rewardType === RewardType.CHARACTER,
    )
    assert.equal(getPlayerItemSync(playerId, 911006), null)
    assert.deepEqual(playerState(playerId), before)
})

test("an empty plan still requires an existing player", () => {
    const missingPlayerId = 999999999

    assert.throws(
        () => executeRewardGrantPlanSync(missingPlayerId, createRewardGrantPlan([])),
        RewardGrantPlayerNotFoundError,
    )
})
