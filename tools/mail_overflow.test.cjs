"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-overflow-"))
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory

const BetterSqlite3 = require("better-sqlite3")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerMailCountSync, getPlayerMailSync, MailType } = require("../src/data/domains/mail")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    insertItemOverflowMailWithinTransactionSync,
    insertManaOverflowMailsWithinTransactionSync,
    insertManaOverflowMailWithinTransactionSync,
    MailOverflowValidationError,
} = require("../src/lib/mail-overflow")

const database = data.initializeDatabase({
    databaseFactory: databasePath => new BetterSqlite3(databasePath),
})
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "mail-overflow-test",
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const now = new Date("2026-09-03T12:34:56.000Z")

assert.throws(
    () => insertManaOverflowMailWithinTransactionSync(playerId, 1, now),
    MailOverflowValidationError,
)

const result = database.transaction(() => {
    const item = insertItemOverflowMailWithinTransactionSync(playerId, 30005, 9, now)
    const mana = insertManaOverflowMailWithinTransactionSync(playerId, 17, now)
    return { item, mana }
})()

assert.deepEqual(result.item, {
    mailId: result.item.mailId,
    type: MailType.ITEM,
    typeId: 30005,
    number: 9,
    createTime: "2026-09-03 12:34:56",
    rewardLimitTime: "2026-10-04 12:34:56",
})
assert.equal(result.mana.type, MailType.FREE_MANA)
assert.equal(result.mana.typeId, null)
assert.equal(result.mana.number, 17)
assert.equal(getPlayerMailSync(playerId, result.item.mailId, true).number, 9)
assert.equal(getPlayerMailSync(playerId, result.mana.mailId, true).number, 17)

const splitMails = database.transaction(() => insertManaOverflowMailsWithinTransactionSync(
    playerId,
    7,
    3,
    now,
))()
assert.deepEqual(splitMails.map(mail => mail.number), [3, 3, 1])
assert.deepEqual(splitMails.map(mail => getPlayerMailSync(playerId, mail.mailId, true).number), [3, 3, 1])

const mailCountBeforeRollback = getPlayerMailCountSync(playerId, true)
assert.throws(() => {
    database.transaction(() => {
        insertManaOverflowMailWithinTransactionSync(playerId, 3, now)
        throw new Error("rollback")
    })()
}, /rollback/)
assert.equal(getPlayerMailCountSync(playerId, true), mailCountBeforeRollback)

database.close()
if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
fs.rmSync(databaseDirectory, { recursive: true, force: true })
console.log("mail overflow owner tests passed")
