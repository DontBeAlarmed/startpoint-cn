"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reward-grant-overflow-"))
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory

const BetterSqlite3 = require("better-sqlite3")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, getPlayerSync } = require("../src/data/domains/player")
const {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
} = require("../src/lib/reward-grant")
const { getPlayerMailSync, getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { RewardType } = require("../src/lib/types")

const database = data.initializeDatabase({
    databaseFactory: databasePath => new BetterSqlite3(databasePath),
})
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "reward-grant-overflow-test",
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const itemId = 30005
const realPolicyItemId = 14041
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(itemId, 8, playerId)
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(realPolicyItemId, 10, playerId)

const overflow = []
const plan = createRewardGrantExecutionPlan([
    { type: RewardType.ITEM, id: itemId, count: 5 },
    { type: RewardType.ITEM, id: itemId, count: 3 },
])
const before = getPlayerSync(playerId)
const result = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    plan,
    {
        playerId: before.id,
        freeMana: before.freeMana,
        freeVmoney: before.freeVmoney,
        expPool: before.expPool,
    },
    {
        itemOverflow: {
            playerId,
            maxCount: () => 10,
            writeOverflow: (id, amount) => overflow.push([id, amount]),
        },
    },
))()

assert.deepEqual(result.assets.items, [{
    itemId,
    requestedAmount: 8,
    acceptedAmount: 2,
    overflowAmount: 6,
    beforeAmount: 8,
    afterAmount: 10,
}])
assert.deepEqual(overflow, [[itemId, 3], [itemId, 3]])
assert.equal(getPlayerItemSync(playerId, itemId), 10)

const realPolicy = createRewardGrantItemOverflowPolicy(playerId, new Date("2026-09-03T12:34:56.000Z"))
const realPolicyBefore = getPlayerSync(playerId)
const realPolicyResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: realPolicyItemId, count: 1 }]),
    {
        playerId: realPolicyBefore.id,
        freeMana: realPolicyBefore.freeMana,
        freeVmoney: realPolicyBefore.freeVmoney,
        expPool: realPolicyBefore.expPool,
    },
    { itemOverflow: realPolicy },
))()
assert.equal(realPolicyResult.assets.items[0].acceptedAmount, 0)
assert.equal(realPolicyResult.assets.items[0].overflowAmount, 1)
const realOverflowMail = getPlayerMailSync(playerId, 1, true)
assert.equal(realOverflowMail.type, MailType.ITEM)
assert.equal(realOverflowMail.type_id, realPolicyItemId)
assert.equal(realOverflowMail.number, 1)
assert.equal(getPlayerItemSync(playerId, realPolicyItemId), 10)

const splitResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: realPolicyItemId, count: 25 }]),
    {
        playerId: realPolicyBefore.id,
        freeMana: realPolicyBefore.freeMana,
        freeVmoney: realPolicyBefore.freeVmoney,
        expPool: realPolicyBefore.expPool,
    },
    { itemOverflow: realPolicy },
))()
assert.equal(splitResult.assets.items[0].overflowAmount, 25)
assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true)
    .filter(mail => mail.type_id === realPolicyItemId)
    .map(mail => mail.number).sort((a, b) => a - b), [1, 5, 10, 10])

const identityBefore = getPlayerSync(playerId)
assert.throws(() => database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: itemId, count: 1 }]),
    {
        playerId: identityBefore.id,
        freeMana: identityBefore.freeMana,
        freeVmoney: identityBefore.freeVmoney,
        expPool: identityBefore.expPool,
    },
    {
        itemOverflow: {
            playerId: playerId + 1,
            maxCount: () => 10,
            writeOverflow() {},
        },
    },
))(), /ITEM_OVERFLOW_PLAYER_MISMATCH/)
assert.equal(getPlayerItemSync(playerId, itemId), 10)

const rollbackBefore = getPlayerSync(playerId)
assert.throws(() => database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: itemId, count: 1 }]),
    {
        playerId: rollbackBefore.id,
        freeMana: rollbackBefore.freeMana,
        freeVmoney: rollbackBefore.freeVmoney,
        expPool: rollbackBefore.expPool,
    },
    {
        itemOverflow: {
            playerId,
            maxCount: () => 10,
            writeOverflow: () => { throw new Error("overflow sink failed") },
        },
    },
))(), /overflow sink failed/)
assert.equal(getPlayerItemSync(playerId, itemId), 10)

database.close()
if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
fs.rmSync(databaseDirectory, { recursive: true, force: true })
console.log("reward grant overflow tests passed")
