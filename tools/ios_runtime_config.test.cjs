"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const path = require("node:path")

require("ts-node/register/transpile-only")

const { parseCnRuntimeConfig } = require("../src/runtime/config")

const projectRoot = path.resolve(__dirname, "..")

function parse(env) {
    return parseCnRuntimeConfig({ projectRoot, env })
}

test("iOS compatibility is disabled by default", () => {
    const config = parse({})
    assert.equal(config.iosCompat.enabled, false)
    assert.equal(config.iosCompat.apiHost, "")
})

test("accepts an explicit reachable host:port", () => {
    const config = parse({ IOS_COMPAT_ENABLED: "1", IOS_API_HOST: "10.0.0.5:8001" })
    assert.equal(config.iosCompat.enabled, true)
    assert.equal(config.iosCompat.apiHost, "10.0.0.5:8001")
    assert.equal(config.iosCompat.apiScheme, "http")
})

test("accepts a bare reachable host and an https scheme", () => {
    const config = parse({
        IOS_COMPAT_ENABLED: "1",
        IOS_API_HOST: "cdn.example.test",
        IOS_API_SCHEME: "https",
    })
    assert.equal(config.iosCompat.enabled, true)
    assert.equal(config.iosCompat.apiHost, "cdn.example.test")
    assert.equal(config.iosCompat.apiScheme, "https")
})

test("accepts a bracketed IPv6 literal with port", () => {
    const config = parse({ IOS_COMPAT_ENABLED: "1", IOS_API_HOST: "[2001:db8::5]:8001" })
    assert.equal(config.iosCompat.enabled, true)
    assert.equal(config.iosCompat.apiHost, "[2001:db8::5]:8001")
})

test("never derives an unreachable default (0.0.0.0 / ::)", () => {
    for (const apiHost of ["0.0.0.0", "0.0.0.0:8001", "::", "[::]:8001"]) {
        const config = parse({ IOS_COMPAT_ENABLED: "1", IOS_API_HOST: apiHost })
        assert.equal(config.iosCompat.enabled, false, apiHost)
    }
})

test("invalid or missing IOS_API_HOST degrades iOS compatibility without crashing", () => {
    for (const apiHost of ["", "bad host:8001", "host:99999", "host:abc", "host:", ":8001"]) {
        const config = parse({ IOS_COMPAT_ENABLED: "1", IOS_API_HOST: apiHost })
        assert.equal(config.iosCompat.enabled, false, JSON.stringify(apiHost))
        assert.equal(config.iosCompat.apiHost, "")
    }
    // 未设置 IOS_API_HOST 时同样降级
    const missing = parse({ IOS_COMPAT_ENABLED: "1" })
    assert.equal(missing.iosCompat.enabled, false)
})

test("Android runtime config is unaffected by iOS configuration", () => {
    const baseline = parse({})
    const withIos = parse({ IOS_COMPAT_ENABLED: "1", IOS_API_HOST: "10.0.0.5:8001" })
    assert.equal(withIos.http.port, baseline.http.port)
    assert.equal(withIos.httpDisplayHost, baseline.httpDisplayHost)
    assert.equal(withIos.multi.mode, baseline.multi.mode)
    assert.equal(withIos.assetProvider.mode, baseline.assetProvider.mode)
})
