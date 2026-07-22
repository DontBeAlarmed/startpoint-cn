"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const { parseCnRuntimeConfig } = require("../src/runtime/config")

test("runtime network defaults are loopback-only and stable", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: { ASSET_MODE: "client-owned" },
    })

    assert.deepEqual(config.http, { host: "127.0.0.1", port: 8001 })
    assert.deepEqual(config.tcp, { host: "127.0.0.1", port: 8003 })
    assert.deepEqual(config.assetProvider, { mode: "client-owned" })
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.http), true)
    assert.equal(Object.isFrozen(config.tcp), true)
})

test("runtime network accepts explicit wildcard hosts and boundary ports", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            CN_LISTEN_HOST: "0.0.0.0",
            CN_LISTEN_PORT: "1",
            SESSION_HOST: "::",
            SESSION_PORT: "65535",
        },
    })

    assert.deepEqual(config.http, { host: "0.0.0.0", port: 1 })
    assert.deepEqual(config.tcp, { host: "::", port: 65535 })
})

for (const host of [
    "localhost",
    "example.com",
    "api-1.internal",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "2001:db8::1",
]) {
    test(`runtime network accepts host ${host}`, () => {
        const config = parseCnRuntimeConfig({
            projectRoot,
            env: {
                ASSET_MODE: "client-owned",
                CN_LISTEN_HOST: host,
                SESSION_HOST: host,
            },
        })
        assert.equal(config.http.host, host)
        assert.equal(config.tcp.host, host)
    })
}

for (const [name, value] of [
    ["empty", ""],
    ["NUL", "host\0name"],
    ["newline", "host\nname"],
    ["DEL", "host\x7fname"],
]) {
    for (const variable of ["CN_LISTEN_HOST", "SESSION_HOST"]) {
        test(`${variable} rejects ${name} hosts`, () => {
            assert.throws(
                () => parseCnRuntimeConfig({
                    projectRoot,
                    env: { ASSET_MODE: "client-owned", [variable]: value },
                }),
                error => error.code === "INVALID_RUNTIME_CONFIG"
                    && error.message === "invalid runtime network configuration",
            )
        })
    }
}

for (const value of [
    " localhost",
    "localhost ",
    "local host",
    "https://localhost",
    "localhost/path",
    "localhost:8001",
    "[::1]",
    "user@localhost",
    "bad_host",
    "-bad.example",
    "bad-.example",
    "bad..example",
    "999.1.1.1",
    `${"a".repeat(64)}.example`,
]) {
    for (const variable of ["CN_LISTEN_HOST", "SESSION_HOST"]) {
        test(`${variable} rejects malformed host ${JSON.stringify(value)}`, () => {
            assert.throws(
                () => parseCnRuntimeConfig({
                    projectRoot,
                    env: { ASSET_MODE: "client-owned", [variable]: value },
                }),
                error => error.code === "INVALID_RUNTIME_CONFIG"
                    && error.message === "invalid runtime network configuration",
            )
        })
    }
}

for (const value of ["", "0", "65536", "1.5", " 80", "80 ", "+80", "1e3", "NaN", "9007199254740992"]) {
    for (const variable of ["CN_LISTEN_PORT", "SESSION_PORT"]) {
        test(`${variable} rejects ${JSON.stringify(value)}`, () => {
            assert.throws(
                () => parseCnRuntimeConfig({
                    projectRoot,
                    env: { ASSET_MODE: "client-owned", [variable]: value },
                }),
                error => error.code === "INVALID_RUNTIME_CONFIG"
                    && error.message === "invalid runtime network configuration",
            )
        })
    }
}
