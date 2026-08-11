"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const iosLeitingRoutes = require("../src/routes/cn/ios-leiting").default

const LOGIN_PATHS = [
    "/mobile!mobileLoginPubV2.action",
    "/login/mobile!mobileLoginPubV2.action",
    "/mobile!sdkLogin.action",
    "/login/mobile!sdkLogin.action",
    "/mobile!guestRegister.action",
    "/login/mobile!guestRegister.action",
    "/mobile!sdkCheckLogin.action",
    "/login/mobile!sdkCheckLogin.action",
    "/sdk/v3-3/code_login_v2.do",
    "/sdk/v3-3/code_login.do",
    "/sdk/v3-3/pwd_login.do",
    "/sdk/v3-3/check_login.do",
    "/sdk/v3-3/check_force.do",
    "/sdk/v3-3/taptap_login.do",
    "/sdk/auth_login.do",
    "/sdk/v3-3/auth_login.do",
]

const STUB_PATHS = [
    "/mobile_two!getRegisterCodeOnly.action",
    "/login/mobile_two!getRegisterCodeOnly.action",
    "/aes/message/send_phone_code",
    "/aes/message/send_login_verify_code",
    "/aes/message/send_bind_phone_login_code",
    "/aes/message/send_register_code",
]

const MG_LOG_PATHS = [
    "/api/mg_log!addMgActivateLog.action",
    "/api/mg_log!addMgCreateRoleLog.action",
    "/api/mg_log!addMgLoginLog.action",
    "/api/mg_log!addMgRegisterLog.action",
]

const SDK_LOG_PATHS = [
    "/api/sdk_log!addScreenLog",
    "/api/sdk_log!addScreenLog.action",
    "/api/sdk_api!getCaidNew",
    "/api/sdk_api!getCaidNew.action",
]

async function createApp(options = {}) {
    const app = Fastify({ logger: false })
    await app.register(iosLeitingRoutes, options)
    await app.ready()
    return app
}

test("all 16 SDK login paths and 6 stub paths are registered", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of [...LOGIN_PATHS, ...STUB_PATHS]) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
    }
})

test("SDK login mock responds on both methods with the expected structure", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of ["/sdk/v3-3/check_login.do", "/mobile!mobileLoginPubV2.action"]) {
        for (const method of ["GET", "POST"]) {
            const response = await app.inject({ method, url })
            assert.equal(response.statusCode, 200, `${method} ${url}`)
            assert.match(response.headers["content-type"], /^application\/json/)
            const body = response.json()
            assert.equal(body.status, "0")
            assert.equal(body.type, "0")
            assert.equal(body.message, "")
            assert.equal(typeof body.data, "string")
            assert.ok(body.data.length > 0, "AES guest UserBean blob must be present")
        }
    }
})

test("SDK stub paths respond with the empty-data structure", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of ["/mobile_two!getRegisterCodeOnly.action", "/aes/message/send_phone_code"]) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
        const body = response.json()
        assert.equal(body.status, "0")
        assert.equal(body.statusCode, "0")
        assert.equal(body.data, "")
    }
})

test("mg_log accepts GET and POST on every path", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of MG_LOG_PATHS) {
        for (const method of ["GET", "POST"]) {
            const response = await app.inject({ method, url })
            assert.equal(response.statusCode, 200, `${method} ${url}`)
            assert.deepEqual(response.json(), { code: 0, message: "success" })
        }
    }
})

test("sdk_log/sdk_api endpoints accept both with and without .action", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of SDK_LOG_PATHS) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
        assert.equal(response.json().code, 0)
    }
})

test("myip returns the request ip", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/myip" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, "127.0.0.1")
})

test("protocol version files remain unavailable without authoritative payloads", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of [
        "/protocols/leiting/sensitive/part/common_version.txt",
        "/protocols/leiting/sensitive/part/wf_version.txt",
    ]) {
        const response = await app.inject({ method: "GET", url })
        assert.equal(response.statusCode, 404, url)
    }
})

test("wf config reflects the configured iOS api host", async t => {
    const app = await createApp({ ios: { apiHost: "10.0.0.5:8001", apiScheme: "http" } })
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/wf/210009_config_20200415.json" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
        default: { apiPath: "10.0.0.5:8001", apiScheme: "http" },
    })
})

test("area/config and sync_data respond successfully", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const area = await app.inject({ method: "GET", url: "/area/config.json" })
    assert.equal(area.statusCode, 200)
    assert.equal(typeof area.json().area_list, "object")

    const sync = await app.inject({ method: "POST", url: "/sync_data", payload: {} })
    assert.equal(sync.statusCode, 200)
    assert.equal(sync.json().code, 0)
})
