"use strict"

// R-18：零测试生产路由的行为覆盖——option/update（写副作用）、tool/signup
// （会话换发）、tool/get_header_response、reproduce/post（遥测接收）、
// carnivalEvent/index（读投影）。

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "zero-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

initializeDatabase()

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("json")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

async function buildApp(routePlugins) {
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
    for (const [modulePath, prefix] of routePlugins) {
        await fastify.register(require(modulePath).default, { prefix })
    }
    await fastify.ready()
    return fastify
}

test("option/update 写入玩家选项并回显（R-18）", async t => {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `zero-option-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800000701
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    const fastify = await buildApp([
        ["../src/routes/api/option", "/api/index.php/option"],
    ])
    t.after(() => fastify.close())

    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/option/update",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            option_params: { option_damage_value: true },
        }),
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = decodeResponse(response)
    assert.equal(body.data.user_option.option_damage_value, true, "响应必须回显写入值")
    const persisted = getDb().prepare(
        "SELECT value FROM players_options WHERE player_id = ? AND key = 'option_damage_value'",
    ).get(playerId)
    assert.notEqual(persisted, undefined, "选项必须持久化")
})

test("tool/signup 以 ZAT 换发 VIEWER 会话；tool/get_header_response 回显 viewer（R-18）", async t => {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `zero-tool-${randomUUID()}`, status: "normal",
    })
    const zatToken = `zat-${randomUUID()}`
    await insertSessionWithToken({
        token: zatToken, accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.ZAT,
    })
    const fastify = await buildApp([
        ["../src/routes/api/tool", "/api/index.php/tool"],
    ])
    t.after(() => fastify.close())

    const signup = await fastify.inject({
        method: "POST",
        url: "/api/index.php/tool/signup",
        headers: { "content-type": "application/x-www-form-urlencoded", udid: "test-udid" },
        payload: encodeRequest({
            app_secret: "s", access_token: zatToken, storage_directory_path: "/d",
            app_admin: "a", kakao_pid: "k", device_id: 1, idp_code: "test",
        }),
    })
    assert.equal(signup.statusCode, 200, signup.body)
    const signupBody = decodeResponse(signup)
    const viewerId = signupBody.data_headers.viewer_id
    assert.ok(viewerId > 0, "signup 必须签发 viewer_id")

    // 重入幂等：同 ZAT 再次 signup 返回同一 viewer
    const again = await fastify.inject({
        method: "POST",
        url: "/api/index.php/tool/signup",
        headers: { "content-type": "application/x-www-form-urlencoded", udid: "test-udid" },
        payload: encodeRequest({
            app_secret: "s", access_token: zatToken, storage_directory_path: "/d",
            app_admin: "a", kakao_pid: "k", device_id: 1, idp_code: "test",
        }),
    })
    assert.equal(decodeResponse(again).data_headers.viewer_id, viewerId, "同 ZAT 重入必须返回同一 viewer")

    const header = await fastify.inject({
        method: "POST",
        url: "/api/index.php/tool/get_header_response",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({ viewer_id: viewerId }),
    })
    assert.equal(header.statusCode, 200)
    assert.equal(decodeResponse(header).data_headers.viewer_id, viewerId, "get_header_response 必须回显 viewer")
})

test("reproduce/post 接收遥测并返回空 data（R-18）", async t => {
    const fastify = await buildApp([
        ["../src/routes/api/reproduce", "/api/index.php/reproduce"],
    ])
    t.after(() => fastify.close())
    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/reproduce/post",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({ viewer_id: 800000702, os_name: "android", device_name: "test" }),
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(decodeResponse(response).data, [])
})

test("carnivalEvent/index 返回活动投影而非 500（R-18）", async t => {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `zero-carnival-${randomUUID()}`, status: "normal",
    })
    const viewerId = 800000703
    insertDefaultPlayerSync(account.id)
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    const fastify = await buildApp([
        ["../src/routes/api/carnivalEvent", "/api/index.php/carnival_event"],
    ])
    t.after(() => fastify.close())
    const response = await fastify.inject({
        method: "POST",
        url: "/api/index.php/carnival_event/index",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({ viewer_id: viewerId, event_id: 1 }),
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.ok(decodeResponse(response).data !== undefined, "必须返回可解析 data")
})
