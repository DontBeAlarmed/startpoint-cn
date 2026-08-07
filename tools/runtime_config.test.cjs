"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const { parseCnRuntimeConfig } = require("../src/runtime/config")
const { resolveDisplayHost } = require("../src/runtime/network-host")

test("runtime network defaults are loopback-only and stable", () => {
    const config = parseCnRuntimeConfig({
        projectRoot,
        env: { ASSET_MODE: "client-owned" },
    })

    assert.deepEqual(config.http, { host: "127.0.0.1", port: 8001 })
    assert.deepEqual(config.multi, {
        mode: "embedded",
        tcp: { host: "127.0.0.1", port: 8003 },
    })
    assert.deepEqual(config.assetProvider, { mode: "client-owned" })
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.http), true)
    assert.equal(Object.isFrozen(config.multi), true)
    assert.equal(Object.isFrozen(config.multi.tcp), true)
})

test("embedded runtime disables bundled comics unless an isolated COMIC_DIR is provided", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-runtime-comic-"))
    const bundleRoot = path.join(sandbox, "bundle")
    const dataRoot = path.join(sandbox, "data")
    const comicRoot = path.join(sandbox, "comic")
    fs.mkdirSync(bundleRoot)
    fs.mkdirSync(dataRoot)
    fs.mkdirSync(comicRoot)

    const disabled = parseCnRuntimeConfig({
        projectRoot: bundleRoot,
        env: { EMBEDDED_RUNTIME: "1", DATA_DIR: dataRoot, ASSET_MODE: "client-owned" },
    })
    assert.equal(disabled.comicDir, null)

    const configured = parseCnRuntimeConfig({
        projectRoot: bundleRoot,
        env: {
            EMBEDDED_RUNTIME: "1",
            DATA_DIR: dataRoot,
            COMIC_DIR: comicRoot,
            ASSET_MODE: "client-owned",
        },
    })
    assert.equal(configured.comicDir, fs.realpathSync(comicRoot))
    fs.rmSync(sandbox, { recursive: true, force: true })
})

test("embedded runtime rejects a COMIC_DIR that overlaps protected inputs", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-runtime-comic-overlap-"))
    const bundleRoot = path.join(sandbox, "bundle")
    const dataRoot = path.join(sandbox, "data")
    fs.mkdirSync(path.join(bundleRoot, "web", "public", "comic"), { recursive: true })
    fs.mkdirSync(dataRoot)

    for (const comicDir of [
        path.join(bundleRoot, "web", "public", "comic"),
        dataRoot,
    ]) {
        assert.throws(
            () => parseCnRuntimeConfig({
                projectRoot: bundleRoot,
                env: {
                    EMBEDDED_RUNTIME: "1",
                    DATA_DIR: dataRoot,
                    COMIC_DIR: comicDir,
                    ASSET_MODE: "client-owned",
                },
            }),
            error => error?.code === "INVALID_RUNTIME_CONFIG",
        )
    }
    fs.rmSync(sandbox, { recursive: true, force: true })
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
    assert.deepEqual(config.multi.tcp, {
        host: "::",
        port: 65535,
        publicHost: resolveDisplayHost({ listenHost: "::" }),
    })
})

test("embedded runtime requires one absolute Data Volume and forbids content path escapes", () => {
    const dataDir = path.join(path.dirname(projectRoot), ".embedded-data-test")
    assert.doesNotThrow(() => parseCnRuntimeConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            EMBEDDED_RUNTIME: "1",
            DATA_DIR: dataDir,
        },
    }))

    for (const env of [
        { EMBEDDED_RUNTIME: "yes", DATA_DIR: dataDir },
        { EMBEDDED_RUNTIME: "1" },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: "relative-data" },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: dataDir, CONTENT_DIR: path.join(projectRoot, "content") },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: dataDir, CONTENT_STORE_DIR: path.join(projectRoot, "store") },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: dataDir, CONTENT_STATE_DIR: path.join(projectRoot, "state") },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: dataDir, CONTENT_RUNTIME_DIR: path.join(projectRoot, "runtime") },
        { EMBEDDED_RUNTIME: "1", DATA_DIR: dataDir, WDFP_DATABASE_DIR: path.join(projectRoot, "legacy") },
    ]) {
        assert.throws(
            () => parseCnRuntimeConfig({
                projectRoot,
                env: { ASSET_MODE: "client-owned", ...env },
            }),
            error => error?.code === "INVALID_RUNTIME_CONFIG",
        )
    }
})

test("embedded Data Volume is physically isolated from the Bundle and local CDN", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-runtime-paths-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const bundleRoot = path.join(sandbox, "bundle")
    const dataRoot = path.join(sandbox, "data")
    const cdnParent = path.join(sandbox, "cdn")
    fs.mkdirSync(bundleRoot)
    fs.mkdirSync(dataRoot)
    fs.mkdirSync(path.join(cdnParent, "cn"), { recursive: true })

    assert.doesNotThrow(() => parseCnRuntimeConfig({
        projectRoot: bundleRoot,
        env: {
            ASSET_MODE: "local",
            CDN_DIR: cdnParent,
            DATA_DIR: dataRoot,
            EMBEDDED_RUNTIME: "1",
        },
    }))

    const bundleAlias = path.join(sandbox, "bundle-alias")
    fs.symlinkSync(bundleRoot, bundleAlias)
    for (const dataDir of [
        bundleRoot,
        path.join(bundleRoot, "data"),
        sandbox,
        path.join(bundleAlias, "missing-data"),
        path.join(cdnParent, "cn", "data"),
        cdnParent,
    ]) {
        assert.throws(
            () => parseCnRuntimeConfig({
                projectRoot: bundleRoot,
                env: {
                    ASSET_MODE: "local",
                    CDN_DIR: cdnParent,
                    DATA_DIR: dataDir,
                    EMBEDDED_RUNTIME: "1",
                },
            }),
            error => error?.code === "INVALID_RUNTIME_CONFIG",
        )
    }
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
        assert.equal(config.multi.tcp.host, host)
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
