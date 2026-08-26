"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let validateScheduledResourceRuleInput
try {
    ({ validateScheduledResourceRuleInput } = require("../src/lib/scheduled-resource-rules"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const authority = {
    itemMaxCounts: { "1": 99, "2": 9999 },
    maxFreeVmoney: 999999,
    playerExists: playerId => playerId === 7,
}

function validItemRule(overrides = {}) {
    return {
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
        description: "每日体力药",
        ...overrides,
    }
}

function expectOk(input) {
    const result = validateScheduledResourceRuleInput(input, authority)
    assert.equal(result.ok, true, result.error)
    return result.value
}

function expectError(input, pattern) {
    const result = validateScheduledResourceRuleInput(input, authority)
    assert.equal(result.ok, false)
    assert.match(result.error, pattern)
}

test("scheduled resource rules accept authoritative Item and free vmoney inputs", () => {
    assert.equal(typeof validateScheduledResourceRuleInput, "function")
    assert.equal(expectOk(validItemRule()).inventoryCap, 99)
    assert.equal(expectOk(validItemRule({
        scope: "player",
        playerId: 7,
        rewardType: "free_vmoney",
        rewardId: null,
        grantAmount: 100,
        triggerThreshold: 1000,
        inventoryCap: 999999,
        startsAtReal: new Date("2026-08-01T00:00:00.000Z"),
        endsAtReal: new Date("2026-09-01T00:00:00.000Z"),
    })).playerId, 7)
})

test("scheduled resource rules reject unsupported ownership and missing authority", () => {
    expectError(validItemRule({ rewardType: "equipment", rewardId: 5010001 }), /奖励类型/)
    expectError(validItemRule({ rewardId: 999 }), /道具 ID/)
    expectError(validItemRule({ inventoryCap: 100 }), /官方上限 99/)
    expectError(validItemRule({
        rewardType: "free_vmoney",
        rewardId: 1,
    }), /免费星导石不填写道具 ID/)
})

test("scheduled resource rules enforce scope, integer, cap, and time boundaries", () => {
    expectError(validItemRule({ scope: "global", playerId: 7 }), /全局规则/)
    expectError(validItemRule({ scope: "player", playerId: 8 }), /存档 8 不存在/)
    expectError(validItemRule({ grantAmount: 0 }), /发放数量/)
    expectError(validItemRule({ triggerThreshold: -1 }), /触发下限/)
    expectError(validItemRule({ inventoryCap: 0 }), /持有上限/)
    expectError(validItemRule({ triggerThreshold: 89 }), /必须小于持有上限/)
    expectError(validItemRule({
        startsAtReal: new Date("2026-09-01T00:00:00.000Z"),
        endsAtReal: new Date("2026-08-01T00:00:00.000Z"),
    }), /结束时间/)
})

console.log("scheduled resource rule tests loaded")
