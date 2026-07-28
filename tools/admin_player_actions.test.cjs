"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-player-actions-"))
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertDeviceBindingSync } = require("../src/data/domains/session")
const playerRoutes = require("../src/routes/web_api/player").default
const serverRoutes = require("../src/routes/web_api/server").default

let database

function createAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
}

function character(exBoost) {
    const now = new Date("2026-07-28T00:00:00.000Z")
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: now,
        updateTime: now,
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [],
        exBoost,
    }
}

async function createAdminServer(t) {
    const app = Fastify({ logger: false })
    app.register(playerRoutes, { prefix: "/api/player" })
    app.register(serverRoutes, { prefix: "/api/server" })
    await app.ready()
    t.after(() => app.close())
    return app
}

test.before(() => {
    database = data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("admin EX Boost clear reports affected characters and removes serialized state", async t => {
    const account = createAccount("ex-clear")
    const playerId = insertDefaultPlayerSync(account.id).id
    insertPlayerCharacterSync(playerId, 100001, character({ statusId: 11, abilityIdList: [21, 22] }))
    insertPlayerCharacterSync(playerId, 100002, character({ statusId: 12, abilityIdList: [23] }))
    const app = await createAdminServer(t)

    const cleared = await app.inject({
        method: "POST",
        url: `/api/player/${playerId}/clear_ex_boost`,
        headers: { accept: "application/json" },
    })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.json(), { ok: true, clearedCharacters: 2 })
    assert.equal(getPlayerCharactersSync(playerId)[100001].exBoost, undefined)
    assert.equal(getPlayerCharactersSync(playerId)[100002].exBoost, undefined)
    assert.deepEqual(
        database.prepare(`
            SELECT ex_boost_status_id, ex_boost_ability_id_list
            FROM players_characters
            WHERE player_id = ? AND id IN (100001, 100002)
            ORDER BY id
        `).all(playerId),
        [
            { ex_boost_status_id: null, ex_boost_ability_id_list: null },
            { ex_boost_status_id: null, ex_boost_ability_id_list: null },
        ],
    )

    const repeated = await app.inject({
        method: "POST",
        url: `/api/player/${playerId}/clear_ex_boost`,
        headers: { accept: "application/json" },
    })
    assert.deepEqual(repeated.json(), { ok: true, clearedCharacters: 0 })

    const missing = await app.inject({
        method: "POST",
        url: "/api/player/2147483647/clear_ex_boost",
        headers: { accept: "application/json" },
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { error: "Player not found" })
})

test("accounts expose device bindings and device names can be changed", async t => {
    const account = createAccount("device-rename")
    insertDefaultPlayerSync(account.id)
    insertDeviceBindingSync(700001, account.id, "旧设备")
    const app = await createAdminServer(t)

    const accounts = await app.inject({ method: "GET", url: "/api/server/accounts" })
    assert.equal(accounts.statusCode, 200)
    const row = accounts.json().find(candidate => candidate.id === account.id)
    assert.deepEqual(row.devices, [{ deviceId: 700001, name: "旧设备" }])

    const renamed = await app.inject({
        method: "POST",
        url: "/api/server/device/rename",
        headers: { accept: "application/json", "content-type": "application/json" },
        payload: { deviceId: 700001, name: "  测试手机  " },
    })
    assert.equal(renamed.statusCode, 200)
    assert.deepEqual(renamed.json(), { ok: true, deviceId: 700001, name: "测试手机" })

    const cleared = await app.inject({
        method: "POST",
        url: "/api/server/device/rename",
        headers: { accept: "application/json", "content-type": "application/json" },
        payload: { deviceId: 700001, name: "   " },
    })
    assert.deepEqual(cleared.json(), { ok: true, deviceId: 700001, name: null })

    const missing = await app.inject({
        method: "POST",
        url: "/api/server/device/rename",
        headers: { accept: "application/json", "content-type": "application/json" },
        payload: { deviceId: 700002, name: "不存在" },
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { error: "Device binding not found" })
})

test("retired SSR-only admin actions are no longer registered", async t => {
    const account = createAccount("retired-actions")
    const playerId = insertDefaultPlayerSync(account.id).id
    const app = await createAdminServer(t)

    for (const url of [
        `/api/player/${playerId}/daily_reset`,
        `/api/player/${playerId}/weekly_reset`,
        `/api/player/${playerId}/clear_mail`,
        `/api/server/selectAccount?accountId=${account.id}`,
    ]) {
        const response = await app.inject({
            method: "POST",
            url,
            headers: { accept: "application/json" },
        })
        assert.equal(response.statusCode, 404, url)
    }
})
