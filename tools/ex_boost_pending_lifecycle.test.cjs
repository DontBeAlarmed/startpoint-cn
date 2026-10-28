"use strict"

// EX 强化 pending 生命周期：异角色 draw = 隐式放弃（链路不阻塞，无 400）；
// 同角色 draw = 免费回放（崩溃恢复路径）；autoAccept 生效事务内清 pending。

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ex-boost-pending-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerCharacterSync } = require("../src/data/domains/character")
const { grantInventoryFixtureItemSync } = require("./helpers/inventory-fixture.cjs")
const { getPendingExBoostDrawSync } = require("../src/data/domains/ex_boost")
const { getPlayerItemSync } = require("../src/data/domains/item")
const exBoostRoutes = require("../src/routes/api/exBoost").default

const CHAR_A = 111001 // element 0, rarity 5（满突破 overLimitStep 4）
const CHAR_B = 111002 // element 0, rarity 5
const STONE = 14001 // tier 1, element 0, 每次消耗 5
const STONE_COST = 5

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

async function buildApp() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(exBoostRoutes, { prefix: "/api/index.php/ex_boost" })
    await fastify.ready()
    return fastify
}

function seedPlayer(t, viewerId) {
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `ex-boost-pending-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    const characterSeed = {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 4, // 5* 满突破：EX 强化的前置条件
        protection: false,
        joinTime: new Date("2024-01-01T00:00:00.000Z"),
        updateTime: new Date("2024-01-01T00:00:00.000Z"),
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [],
    }
    insertPlayerCharacterSync(playerId, CHAR_A, characterSeed)
    insertPlayerCharacterSync(playerId, CHAR_B, characterSeed)
    grantInventoryFixtureItemSync(playerId, STONE, 100)
    t.after(() => {
        db.prepare("DELETE FROM players_ex_boost_pending_draws WHERE player_id = ?").run(playerId)
    })
    return playerId
}

async function postDraw(fastify, viewerId, characterId) {
    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/ex_boost/draw",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            character_id: characterId,
            cost_item_id: STONE,
            api_count: 1,
        }),
    })
    return { response, body: decodeResponse(response) }
}

async function postFirstDraw(fastify, viewerId, characterId) {
    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/ex_boost/first_draw",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            character_id: characterId,
            cost_item_id: STONE,
            api_count: 1,
        }),
    })
    return { response, body: decodeResponse(response) }
}

async function postSelect(fastify, viewerId, isConfirm) {
    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/ex_boost/select",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            is_confirm: isConfirm,
            api_count: 1,
        }),
    })
    return { response, body: decodeResponse(response) }
}

test("EX pending 生命周期：同角色回放免费、异角色隐式放弃、autoAccept 清档", async t => {
    initializeDatabase()
    const viewerId = 800000511
    seedPlayer(t, viewerId)
    const fastify = await buildApp()
    t.after(() => fastify.close())

    // 1) 首次 draw：扣费 5，写 pending
    const first = await postDraw(fastify, viewerId, CHAR_A)
    assert.equal(first.response.statusCode, 200, first.response.body)
    const pid = viewerIdToPlayerId(viewerId)
    const firstStones = stonesOf(pid)
    assert.equal(firstStones, 100 - STONE_COST, "首次 draw 必须扣费")

    // 2) 同角色再次 draw：免费回放同一结果，不二次扣费
    const replay = await postDraw(fastify, viewerId, CHAR_A)
    assert.equal(replay.response.statusCode, 200)
    assert.equal(replay.body.data.draw_result.status_id, first.body.data.draw_result.status_id, "回放必须返回同一抽取结果")
    assert.deepEqual(replay.body.data.draw_result.ability_id_list, first.body.data.draw_result.ability_id_list)
    assert.equal(stonesOf(pid), firstStones, "回放不得二次扣费")

    // 3) 异角色 draw：隐式放弃 A 的 pending，链路不阻塞（无 400），pending 换成 B
    const other = await postDraw(fastify, viewerId, CHAR_B)
    assert.equal(other.response.statusCode, 200, other.response.body, "异角色 draw 不得 400")
    assert.equal(other.body.data.character_id, CHAR_B)
    const pending = getPendingExBoostDrawSync(viewerIdToPlayerId(viewerId))
    assert.equal(pending?.characterId, CHAR_B, "异角色 draw 必须隐式放弃 A 并写入 B 的 pending")
    const stonesAfterB = stonesOf(pid)
    assert.equal(stonesAfterB, firstStones - STONE_COST, "B 的抽取必须正常扣费一次")

    // 4) 放弃 B 的结果（显式放弃语义）：pending 清空，材料不退
    const discard = await postSelect(fastify, viewerId, false)
    assert.equal(discard.response.statusCode, 200)
    assert.equal(getPendingExBoostDrawSync(viewerIdToPlayerId(viewerId)), null)
    assert.equal(stonesOf(pid), stonesAfterB, "显式放弃不退费（既有语义）")
})

test("EX first_draw 在存在异角色 pending 时同样不阻塞并清档生效", async t => {
    initializeDatabase()
    const viewerId = 800000512
    const playerId = seedPlayer(t, viewerId)
    const fastify = await buildApp()
    t.after(() => fastify.close())

    const first = await postDraw(fastify, viewerId, CHAR_A)
    assert.equal(first.response.statusCode, 200)
    assert.equal(getPendingExBoostDrawSync(playerId)?.characterId, CHAR_A)

    const auto = await postFirstDraw(fastify, viewerId, CHAR_B)
    assert.equal(auto.response.statusCode, 200, auto.response.body, "first_draw 不得被 pending 400 阻塞")
    assert.ok(auto.body.data.character_list?.length === 1, "first_draw 必须直接生效（character_list 补丁）")
    assert.equal(getPendingExBoostDrawSync(playerId), null, "autoAccept 生效事务内必须清 pending")
})

test("select 在无 pending 时保持 400（协议守卫不回退）", async t => {
    initializeDatabase()
    const viewerId = 800000513
    seedPlayer(t, viewerId)
    const fastify = await buildApp()
    t.after(() => fastify.close())

    const select = await postSelect(fastify, viewerId, true)
    assert.equal(select.response.statusCode, 400)
})

// seedPlayer 用 viewerId 建 session；这里按 token=viewerId 约定反查 player_id
const { getPlayerSync } = require("../src/data/domains/player")
function viewerIdToPlayerId(viewerId) {
    const row = getDb().prepare(
        "SELECT p.id AS id FROM players p JOIN sessions s ON s.account_id = p.account_id WHERE s.token = ?",
    ).get(String(viewerId))
    assert.ok(row, "session/player join must resolve")
    return row.id
}

function stonesOf(playerId) {
    return getPlayerItemSync(playerId, STONE) ?? 0
}
