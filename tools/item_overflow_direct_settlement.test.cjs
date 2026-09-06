"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "item-overflow-direct-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = directory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    settleDirectItemOverflowsWithinTransactionSync,
} = require("../src/lib/item-overflow/direct-settlement")

let database
let playerId

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath),
    })
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "item-overflow-direct-test",
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
})

test.after(() => {
    restoreContentSnapshot()
    data.closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("direct settlement sells sellable overflow and mails unsellable overflow in order", () => {
    const before = getPlayerSync(playerId)
    const result = database.transaction(() => settleDirectItemOverflowsWithinTransactionSync({
        playerId,
        overflows: [
            { itemId: 1, amount: 2 },
            { itemId: 30102, amount: 3 },
        ],
        now: new Date("2026-09-03T12:34:56.000Z"),
    }))()

    assert.equal(result.freeManaAfter, before.freeMana + 10)
    assert.deepEqual(result.dispositions, [
        {
            kind: "sold",
            itemId: 1,
            overflowAmount: 2,
            soldMana: 10,
            manaBefore: before.freeMana,
            acceptedMana: 10,
            overflowMana: 0,
            manaAfter: before.freeMana + 10,
        },
        { kind: "mail", itemId: 30102, overflowAmount: 3 },
    ])
    assert.equal(getPlayerSync(playerId).totalManaObtained, before.totalManaObtained + 10)
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.ITEM)
        .map(mail => [mail.type_id, mail.number]), [[30102, 3]])
})

test("direct settlement sends sold Mana beyond capacity to FREE_MANA Mail", () => {
    const player = getPlayerSync(playerId)
    updatePlayerSync({ id: playerId, freeMana: 99999999 - player.paidMana - 5 })
    const before = getPlayerSync(playerId)
    const result = database.transaction(() => settleDirectItemOverflowsWithinTransactionSync({
        playerId,
        overflows: [{ itemId: 1, amount: 2 }],
    }))()

    assert.equal(result.freeManaAfter, before.freeMana + 5)
    assert.equal(result.dispositions[0].overflowMana, 5)
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.FREE_MANA)
        .map(mail => mail.number), [5])
})

test("direct settlement requires a transaction and rolls all effects back", () => {
    assert.throws(() => settleDirectItemOverflowsWithinTransactionSync({
        playerId,
        overflows: [{ itemId: 1, amount: 1 }],
    }), /transaction/i)

    const before = getPlayerSync(playerId)
    const mailsBefore = getPlayerMailsSync(playerId, 1, 100, true)
    assert.throws(() => database.transaction(() => {
        settleDirectItemOverflowsWithinTransactionSync({
            playerId,
            overflows: [{ itemId: 1, amount: 1 }],
        })
        throw new Error("late direct source failure")
    })(), /late direct source failure/)
    assert.deepEqual(getPlayerSync(playerId), before)
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true), mailsBefore)
})

test("direct settlement rejects malformed overflow input", () => {
    for (const overflows of [
        null,
        [{ itemId: 0, amount: 1 }],
        [{ itemId: 1, amount: 0 }],
        [{ itemId: 1, amount: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
        assert.throws(() => database.transaction(() => (
            settleDirectItemOverflowsWithinTransactionSync({ playerId, overflows })
        ))())
    }
})
