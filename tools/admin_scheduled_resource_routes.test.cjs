"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-scheduled-resource-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")

let scheduledResourceRoutes
try {
    scheduledResourceRoutes = require("../src/routes/web_api/scheduled-resource").default
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

let app
let player

function responseJson(response) {
    return JSON.parse(response.payload)
}

test.before(async () => {
    assert.equal(typeof scheduledResourceRoutes, "function")
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "admin-scheduled-resource",
        status: "normal",
    })
    player = insertDefaultPlayerSync(account.id)
    app = Fastify({ logger: false })
    app.register(scheduledResourceRoutes, { prefix: "/api/scheduled-resource" })
    await app.ready()
})

test.after(async () => {
    await app?.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("scheduled resource admin routes create and list authoritative rules", async () => {
    const created = await app.inject({
        method: "POST",
        url: "/api/scheduled-resource",
        payload: {
            scope: "global",
            playerId: null,
            rewardType: "item",
            rewardId: 1,
            grantAmount: 2,
            triggerThreshold: 5,
            inventoryCap: 99,
            enabled: true,
            startsAtReal: null,
            endsAtReal: null,
            description: "全局补充",
        },
    })
    assert.equal(created.statusCode, 201, created.payload)
    const createdRule = responseJson(created)
    assert.equal(createdRule.rewardName.length > 0, true)
    assert.equal(createdRule.officialMaxCount >= 99, true)

    const playerRuleResponse = await app.inject({
        method: "POST",
        url: "/api/scheduled-resource",
        payload: {
            scope: "player",
            playerId: player.id,
            rewardType: "free_vmoney",
            rewardId: null,
            grantAmount: 100,
            triggerThreshold: 1000,
            inventoryCap: 999999,
            enabled: false,
            startsAtReal: "2026-08-01T00:00:00.000Z",
            endsAtReal: "2026-09-01T00:00:00.000Z",
            description: "指定存档",
        },
    })
    assert.equal(playerRuleResponse.statusCode, 201, playerRuleResponse.payload)

    const listed = await app.inject({ method: "GET", url: "/api/scheduled-resource" })
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(responseJson(listed).map(rule => rule.id), [
        responseJson(playerRuleResponse).id,
        createdRule.id,
    ])
})

test("scheduled resource admin routes edit, toggle, delete, and reject invalid rules", async () => {
    const invalid = await app.inject({
        method: "POST",
        url: "/api/scheduled-resource",
        payload: {
            scope: "global",
            playerId: null,
            rewardType: "equipment",
            rewardId: 5010001,
            grantAmount: 1,
            triggerThreshold: 1,
            inventoryCap: 10,
            enabled: true,
            startsAtReal: null,
            endsAtReal: null,
            description: null,
        },
    })
    assert.equal(invalid.statusCode, 400)
    assert.match(responseJson(invalid).error, /奖励类型/)

    const firstList = responseJson(await app.inject({ method: "GET", url: "/api/scheduled-resource" }))
    const rule = firstList[0]
    const edited = await app.inject({
        method: "PATCH",
        url: `/api/scheduled-resource/${rule.id}`,
        payload: {
            scope: "player",
            playerId: player.id,
            rewardType: "free_vmoney",
            rewardId: null,
            grantAmount: 50,
            triggerThreshold: 500,
            inventoryCap: 999999,
            enabled: true,
            startsAtReal: null,
            endsAtReal: null,
            description: "已编辑",
        },
    })
    assert.equal(edited.statusCode, 200, edited.payload)
    assert.equal(responseJson(edited).id, rule.id)
    assert.equal(responseJson(edited).description, "已编辑")

    const toggled = await app.inject({
        method: "PATCH",
        url: `/api/scheduled-resource/${rule.id}/enabled`,
        payload: { enabled: false },
    })
    assert.equal(toggled.statusCode, 200)
    assert.equal(responseJson(toggled).enabled, false)

    const removed = await app.inject({
        method: "DELETE",
        url: `/api/scheduled-resource/${rule.id}`,
    })
    assert.equal(removed.statusCode, 200)
    assert.deepEqual(responseJson(removed), { ok: true })
    const missing = await app.inject({
        method: "DELETE",
        url: `/api/scheduled-resource/${rule.id}`,
    })
    assert.equal(missing.statusCode, 404)
})

console.log("admin scheduled resource route tests loaded")
