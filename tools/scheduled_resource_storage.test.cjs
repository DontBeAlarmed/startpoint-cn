"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-resource-storage-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")

let scheduledResource = {}
try {
    scheduledResource = require("../src/data/domains/scheduled-resource")
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const {
    deleteScheduledResourceRuleSync,
    getScheduledResourceRuleSync,
    getScheduledResourceStatesByRuleIdsSync,
    insertScheduledResourceRuleSync,
    listScheduledResourceRulesSync,
    listScheduledResourceRulesForPlayerSync,
    recordScheduledResourceGrantsWithinTransactionSync,
    updateScheduledResourceRuleSync,
} = scheduledResource

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id)
}

test.before(() => {
    assert.equal(typeof insertScheduledResourceRuleSync, "function")
    data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("scheduled resource storage keeps global and player rules with stable CRUD", () => {
    const player = createPlayer("scheduled-storage-player")
    const createdAt = new Date("2026-08-26T01:00:00.000Z")
    const globalRule = insertScheduledResourceRuleSync({
        scope: "global",
        playerId: null,
        rewardType: "item",
        rewardId: 1,
        grantAmount: 10,
        triggerThreshold: 20,
        inventoryCap: 100,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: "全服体力药",
    }, createdAt)
    const playerRule = insertScheduledResourceRuleSync({
        scope: "player",
        playerId: player.id,
        rewardType: "free_vmoney",
        rewardId: null,
        grantAmount: 100,
        triggerThreshold: 200,
        inventoryCap: 999999,
        enabled: false,
        startsAtReal: new Date("2026-08-20T00:00:00.000Z"),
        endsAtReal: new Date("2026-09-01T00:00:00.000Z"),
        description: null,
    }, createdAt)

    assert.equal(globalRule.id > 0, true)
    assert.equal(playerRule.id > globalRule.id, true)
    assert.deepEqual(listScheduledResourceRulesSync().map(rule => rule.id), [playerRule.id, globalRule.id])
    assert.deepEqual(
        listScheduledResourceRulesForPlayerSync(player.id).map(rule => rule.id),
        [globalRule.id],
        "候选读取只返回启用的全局规则和该存档规则",
    )

    const updated = updateScheduledResourceRuleSync(playerRule.id, {
        ...playerRule,
        enabled: true,
        description: "指定存档星导石",
    }, new Date("2026-08-26T02:00:00.000Z"))
    assert.equal(updated.id, playerRule.id)
    assert.equal(updated.enabled, true)
    assert.equal(updated.description, "指定存档星导石")
    assert.deepEqual(
        listScheduledResourceRulesForPlayerSync(player.id).map(rule => rule.id),
        [globalRule.id, playerRule.id],
    )
    assert.equal(getScheduledResourceRuleSync(playerRule.id).updatedAtReal.toISOString(), "2026-08-26T02:00:00.000Z")

    assert.equal(deleteScheduledResourceRuleSync(globalRule.id), true)
    assert.equal(deleteScheduledResourceRuleSync(globalRule.id), false)
    assert.equal(getScheduledResourceRuleSync(globalRule.id), null)
})

test("scheduled resource grant states batch read and cascade with rules and players", () => {
    const player = createPlayer("scheduled-storage-state-player")
    const rule = insertScheduledResourceRuleSync({
        scope: "player",
        playerId: player.id,
        rewardType: "item",
        rewardId: 2,
        grantAmount: 5,
        triggerThreshold: 10,
        inventoryCap: 99,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: null,
    }, new Date("2026-08-26T03:00:00.000Z"))

    getDb().transaction(() => {
        recordScheduledResourceGrantsWithinTransactionSync(
            player.id,
            [rule.id],
            "2026-08-26",
            new Date("2026-08-26T04:00:00.000Z"),
        )
    })()
    const states = getScheduledResourceStatesByRuleIdsSync(player.id, [rule.id, 999999])
    assert.equal(states[rule.id].lastGrantedBusinessDay, "2026-08-26")
    assert.equal(states[rule.id].lastGrantedAtReal.toISOString(), "2026-08-26T04:00:00.000Z")

    assert.equal(deleteScheduledResourceRuleSync(rule.id), true)
    assert.deepEqual(getScheduledResourceStatesByRuleIdsSync(player.id, [rule.id]), {})

    const cascadeRule = insertScheduledResourceRuleSync({
        scope: "player",
        playerId: player.id,
        rewardType: "item",
        rewardId: 3,
        grantAmount: 1,
        triggerThreshold: 2,
        inventoryCap: 10,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: null,
    }, new Date("2026-08-26T05:00:00.000Z"))
    getDb().prepare("DELETE FROM players WHERE id = ?").run(player.id)
    assert.equal(getScheduledResourceRuleSync(cascadeRule.id), null)
})

console.log("scheduled resource storage tests loaded")
