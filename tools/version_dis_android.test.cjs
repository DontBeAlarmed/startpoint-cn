"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const versionCheckPlugin = require("../src/routes/cn/versionCheck").default

// Android .dis 必须与历史官方响应逐字节一致（回归保护）。
const ANDROID_DIS = "// 用于官服正式用\r\n{\"default\":{\"apiPath\":\"shijtswygamegf.leiting.com\"}}"

async function loadDis(options, url) {
    const app = Fastify()
    await app.register(versionCheckPlugin, options)
    const response = await app.inject({ method: "GET", url })
    await app.close()
    return response
}

test("android .dis is byte-identical to the legacy official response", async () => {
    const response = await loadDis({}, "/shijtswy/version/client_release_android.dis")
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, ANDROID_DIS)
})

test("android .dis stays byte-identical when iOS compatibility is enabled", async () => {
    const response = await loadDis(
        { ios: { enabled: true, apiHost: "10.0.0.5:8001", apiScheme: "http" } },
        "/shijtswy/version/client_release_android.dis",
    )
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, ANDROID_DIS)
})

test("ios .dis falls back to the android response when iOS compatibility is disabled", async () => {
    const response = await loadDis({}, "/shijtswy/version/client_release_ios.dis")
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, ANDROID_DIS)
})

test("ios .dis matches the real-device-verified fixture bytes (structure, no trailing newline)", async () => {
    // 实机验证过的精确字节（iPhone 成功进入游戏时服务器实际下发，与 launcher 作者实机取证结构一致）：
    // "// 用于官服正式用\r\n{\"default\":{\"apiPath\":\"198.51.100.7:7001\",\"apiScheme\":\"http\"}}"
    // 结构要点：// 注释行 + 单个 CRLF 分隔 + 第二行 JSON 对象，无尾部换行。
    const response = await loadDis(
        { ios: { enabled: true, apiHost: "198.51.100.7:7001", apiScheme: "http" } },
        "/shijtswy/version/client_release_ios.dis",
    )
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /text\/plain/)
    assert.equal(
        response.body,
        "// 用于官服正式用\r\n{\"default\":{\"apiPath\":\"198.51.100.7:7001\",\"apiScheme\":\"http\"}}",
    )
    assert.equal(response.body.endsWith("\r\n"), false) // 无尾部换行
})

test("ios .dis returns the configured reachable api host when enabled", async () => {
    const response = await loadDis(
        { ios: { enabled: true, apiHost: "10.0.0.5:8001", apiScheme: "http" } },
        "/shijtswy/version/client_release_ios.dis",
    )
    assert.equal(response.statusCode, 200)
    assert.equal(
        response.body,
        "// 用于官服正式用\r\n{\"default\":{\"apiPath\":\"10.0.0.5:8001\",\"apiScheme\":\"http\"}}",
    )
})
