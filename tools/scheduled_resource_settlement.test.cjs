"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-resource-settlement-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, setPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    getScheduledResourceStatesByRuleIdsSync,
    insertScheduledResourceRuleSync,
} = require("../src/data/domains/scheduled-resource")

let settleScheduledResourcesSync
try {
    ({ settleScheduledResourcesSync } = require("../src/lib/scheduled-resource-settlement"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const itemMaxCounts = { "1": 99, "2": 9999, "3": 9999 }
const maxFreeVmoney = 999999

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

function insertRule(overrides = {}) {
    return insertScheduledResourceRuleSync({
        scope: "global",
        playerId: null,
        rewardType: "item",
        rewardId: 1,
        grantAmount: 10,
        triggerThreshold: 20,
        inventoryCap: 99,
        enabled: true,
        startsAtReal: null,
        endsAtReal: null,
        description: null,
        ...overrides,
    }, new Date("2026-08-20T00:00:00.000Z"))
}

function settle(playerId, realNow) {
    return settleScheduledResourcesSync({
        player: getPlayerSync(playerId),
        realNow,
        dailyResetHour: 5,
        itemMaxCounts,
        maxFreeVmoney,
    })
}

test.before(() => {
    assert.equal(typeof settleScheduledResourcesSync, "function")
    data.initializeDatabase()
})

test.beforeEach(() => {
    getDb().prepare("DELETE FROM scheduled_resource_rules").run()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("global and player rules grant independently and coalesce the same item", () => {
    const player = createPlayer("scheduled-settlement-combined")
    setPlayerItemSync(player.id, 1, 5)
    const globalRule = insertRule()
    const playerRule = insertRule({
        scope: "player",
        playerId: player.id,
        grantAmount: 7,
        triggerThreshold: 10,
    })

    const result = settle(player.id, new Date("2026-08-26T01:00:00.000Z"))
    assert.equal(result.status, "granted")
    assert.deepEqual(result.grantedRuleIds, [globalRule.id, playerRule.id])
    assert.equal(getPlayerItemSync(player.id, 1), 22)
    assert.equal(result.rewardResult.aggregate.items[1], 22)
    const states = getScheduledResourceStatesByRuleIdsSync(player.id, [globalRule.id, playerRule.id])
    assert.equal(states[globalRule.id].lastGrantedBusinessDay, "2026-08-26")
    assert.equal(states[playerRule.id].lastGrantedBusinessDay, "2026-08-26")
})

test("a rule records only successful grants and can trigger after same-day consumption", () => {
    const player = createPlayer("scheduled-settlement-threshold")
    setPlayerItemSync(player.id, 2, 50)
    const rule = insertRule({ rewardId: 2, inventoryCap: 9999 })
    const now = new Date("2026-08-26T02:00:00.000Z")

    assert.equal(settle(player.id, now).status, "none")
    assert.deepEqual(getScheduledResourceStatesByRuleIdsSync(player.id, [rule.id]), {})

    setPlayerItemSync(player.id, 2, 5)
    assert.equal(settle(player.id, now).status, "granted")
    assert.equal(getPlayerItemSync(player.id, 2), 15)
    assert.equal(settle(player.id, now).status, "none")
    assert.equal(getPlayerItemSync(player.id, 2), 15)

    assert.equal(settle(player.id, new Date("2026-08-27T02:00:00.000Z")).status, "granted")
    assert.equal(getPlayerItemSync(player.id, 2), 25)
})

test("real enable windows and reset hour determine eligibility without catch-up", () => {
    const player = createPlayer("scheduled-settlement-window")
    const active = insertRule({
        rewardId: 3,
        inventoryCap: 9999,
        startsAtReal: new Date("2026-08-25T00:00:00.000Z"),
        endsAtReal: new Date("2026-08-27T00:00:00.000Z"),
    })
    insertRule({
        rewardId: 3,
        inventoryCap: 9999,
        triggerThreshold: 100,
        startsAtReal: new Date("2026-08-27T00:00:00.000Z"),
    })

    const beforeReset = settle(player.id, new Date("2026-08-25T20:59:59.000Z"))
    assert.equal(beforeReset.status, "granted")
    assert.equal(
        getScheduledResourceStatesByRuleIdsSync(player.id, [active.id])[active.id].lastGrantedBusinessDay,
        "2026-08-25",
    )
    assert.equal(settle(player.id, new Date("2026-08-25T21:00:00.000Z")).status, "granted")
    assert.equal(settle(player.id, new Date("2026-08-27T00:00:00.000Z")).status, "granted")
    assert.equal(getPlayerItemSync(player.id, 3), 30, "结束边界不应补发已结束规则")
})

test("free vmoney grants use the same daily state", () => {
    const player = createPlayer("scheduled-settlement-vmoney")
    updatePlayerSync({ id: player.id, freeVmoney: 100 })
    const rule = insertRule({
        rewardType: "free_vmoney",
        rewardId: null,
        grantAmount: 50,
        triggerThreshold: 200,
        inventoryCap: 999999,
    })
    assert.equal(settle(player.id, new Date("2026-08-26T03:00:00.000Z")).status, "granted")
    assert.equal(getPlayerSync(player.id).freeVmoney, 150)
    assert.equal(
        getScheduledResourceStatesByRuleIdsSync(player.id, [rule.id])[rule.id].lastGrantedBusinessDay,
        "2026-08-26",
    )
})

test("state write failure rolls reward and state back together", () => {
    const player = createPlayer("scheduled-settlement-rollback")
    const rule = insertRule({ rewardId: 2, inventoryCap: 9999 })
    setPlayerItemSync(player.id, 2, 1)
    getDb().exec(`
        CREATE TRIGGER fail_scheduled_resource_state
        BEFORE INSERT ON players_scheduled_resource_state
        BEGIN
            SELECT RAISE(ABORT, 'state write failed');
        END
    `)
    assert.throws(
        () => settle(player.id, new Date("2026-08-26T04:00:00.000Z")),
        /state write failed/,
    )
    getDb().exec("DROP TRIGGER fail_scheduled_resource_state")
    assert.equal(getPlayerItemSync(player.id, 2), 1)
    assert.deepEqual(getScheduledResourceStatesByRuleIdsSync(player.id, [rule.id]), {})
})

console.log("scheduled resource settlement tests loaded")
