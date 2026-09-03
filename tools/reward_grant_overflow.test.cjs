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
const { insertDefaultPlayerSync, getPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
} = require("../src/lib/reward-grant")
const { getPlayerMailSync, getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { RewardType } = require("../src/lib/types")
const maxMana = require("../assets/config.json").max_mana

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
const unsellableItemId = 30102
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(itemId, 8, playerId)
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(realPolicyItemId, 10, playerId)
database.prepare(
    "INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)",
).run(unsellableItemId, 99999, playerId)

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
            planOverflow: (id, amount) => ({
                kind: "mail",
                itemId: id,
                overflowAmount: amount,
            }),
            finalizeOverflow: disposition => overflow.push([
                disposition.itemId,
                disposition.overflowAmount,
            ]),
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
    overflowDispositions: [
        { kind: "mail", itemId, overflowAmount: 3 },
        { kind: "mail", itemId, overflowAmount: 3 },
    ],
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
assert.deepEqual(realPolicyResult.assets.items[0].overflowDispositions, [{
    kind: "sold",
    itemId: realPolicyItemId,
    overflowAmount: 1,
    soldMana: 500,
    manaBefore: realPolicyBefore.freeMana,
    acceptedMana: 500,
    overflowMana: 0,
    manaAfter: realPolicyBefore.freeMana + 500,
}])
assert.equal(realPolicyResult.playerAfter.freeMana, realPolicyBefore.freeMana + 500)
assert.equal(getPlayerSync(playerId).freeMana, realPolicyBefore.freeMana + 500)
assert.equal(getPlayerMailsSync(playerId, 1, 100, true)
    .some(mail => mail.type === MailType.ITEM && mail.type_id === realPolicyItemId), false)
assert.equal(getPlayerItemSync(playerId, realPolicyItemId), 10)

const unsellableBefore = getPlayerSync(playerId)
const unsellableResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: unsellableItemId, count: 25 }]),
    {
        playerId: unsellableBefore.id,
        freeMana: unsellableBefore.freeMana,
        freeVmoney: unsellableBefore.freeVmoney,
        expPool: unsellableBefore.expPool,
    },
    { itemOverflow: realPolicy },
))()
assert.equal(unsellableResult.assets.items[0].overflowAmount, 25)
assert.deepEqual(unsellableResult.assets.items[0].overflowDispositions, [{
    kind: "mail",
    itemId: unsellableItemId,
    overflowAmount: 25,
}])
assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true)
    .filter(mail => mail.type_id === unsellableItemId)
    .map(mail => mail.number), [25])

const manaBeforeItem = getPlayerSync(playerId)
const manaBeforeItemResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([
        { type: RewardType.MANA, count: 10 },
        { type: RewardType.ITEM, id: realPolicyItemId, count: 1 },
    ]),
    {
        playerId: manaBeforeItem.id,
        freeMana: manaBeforeItem.freeMana,
        freeVmoney: manaBeforeItem.freeVmoney,
        expPool: manaBeforeItem.expPool,
    },
    { itemOverflow: realPolicy },
))()
assert.deepEqual(manaBeforeItemResult.assets.currencies, [{
    currency: "freeMana",
    requestedAmount: 510,
    beforeAmount: manaBeforeItem.freeMana,
    afterAmount: manaBeforeItem.freeMana + 510,
}])

const itemBeforeMana = getPlayerSync(playerId)
const itemBeforeManaResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: realPolicyItemId, count: 1 },
        { type: RewardType.MANA, count: 10 },
    ]),
    {
        playerId: itemBeforeMana.id,
        freeMana: itemBeforeMana.freeMana,
        freeVmoney: itemBeforeMana.freeVmoney,
        expPool: itemBeforeMana.expPool,
    },
    { itemOverflow: realPolicy },
))()
assert.deepEqual(itemBeforeManaResult.assets.currencies, [{
    currency: "freeMana",
    requestedAmount: 510,
    beforeAmount: itemBeforeMana.freeMana,
    afterAmount: itemBeforeMana.freeMana + 510,
}])

const capacityPlayer = getPlayerSync(playerId)
updatePlayerSync({
    id: playerId,
    freeMana: maxMana - capacityPlayer.paidMana - 100,
})
const capacityBefore = getPlayerSync(playerId)
const capacityResult = database.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
    playerId,
    createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: realPolicyItemId, count: 1 }]),
    {
        playerId: capacityBefore.id,
        freeMana: capacityBefore.freeMana,
        freeVmoney: capacityBefore.freeVmoney,
        expPool: capacityBefore.expPool,
    },
    { itemOverflow: createRewardGrantItemOverflowPolicy(playerId) },
))()
assert.equal(capacityResult.playerAfter.freeMana, capacityBefore.freeMana + 100)
assert.equal(getPlayerSync(playerId).totalManaObtained, capacityBefore.totalManaObtained + 100)
assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true)
    .filter(mail => mail.type === MailType.FREE_MANA)
    .map(mail => mail.number), [400])

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
            planOverflow: (id, amount) => ({ kind: "mail", itemId: id, overflowAmount: amount }),
            finalizeOverflow() {},
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
            planOverflow: (id, amount) => ({ kind: "mail", itemId: id, overflowAmount: amount }),
            finalizeOverflow: () => { throw new Error("overflow sink failed") },
        },
    },
))(), /overflow sink failed/)
assert.equal(getPlayerItemSync(playerId, itemId), 10)

database.close()
if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
fs.rmSync(databaseDirectory, { recursive: true, force: true })
console.log("reward grant overflow tests passed")
