"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const Fastify = require("fastify")
const { readAdminApiToken, requireAdminApiToken } = require("../src/runtime/admin-auth")

const repositoryRoot = path.resolve(__dirname, "..")

function withEnv(patches, fn) {
    const previous = {}
    for (const [key, value] of Object.entries(patches)) {
        previous[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        fn()
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test("readAdminApiToken: unset/blank means no auth (private posture), whitespace-only warns", () => {
    withEnv({ ADMIN_API_TOKEN: undefined }, () => {
        assert.equal(readAdminApiToken(), null)
    })
    withEnv({ ADMIN_API_TOKEN: "" }, () => {
        assert.equal(readAdminApiToken(), null)
    })
    // 设了值但全空白：仍不鉴权（trim 后 falsy），但必须可被日志察觉
    let warned = false
    const originalWarn = console.warn
    console.warn = () => { warned = true }
    try {
        withEnv({ ADMIN_API_TOKEN: "   " }, () => {
            assert.equal(readAdminApiToken(), null)
        })
    } finally {
        console.warn = originalWarn
    }
    assert.equal(warned, true, "blank-but-set ADMIN_API_TOKEN must produce a posture warning")
    withEnv({ ADMIN_API_TOKEN: "  token-value  " }, () => {
        assert.equal(readAdminApiToken(), "token-value")
    })
})

function buildScopedApp(token) {
    const app = Fastify({ logger: false })
    app.register(async function adminApiScope(scope) {
        if (token !== null) requireAdminApiToken(scope, token)
        scope.get("/api/server/ping", () => ({ ok: true }))
    })
    app.get("/api/index.php/tool/ping", () => ({ ok: true }))
    return app
}

test("admin gate: unset token keeps legacy no-auth behavior; game routes never gated", async () => {
    const app = buildScopedApp(null)
    await app.ready()
    const admin = await app.inject({ method: "GET", url: "/api/server/ping" })
    assert.equal(admin.statusCode, 200)
    const game = await app.inject({ method: "GET", url: "/api/index.php/tool/ping" })
    assert.equal(game.statusCode, 200)
    await app.close()
})

test("admin gate: missing/wrong/right token 401/401/200 with identical 401 shape", async () => {
    const token = "test-token-0123456789abcdef"
    const app = buildScopedApp(token)
    await app.ready()
    const missing = await app.inject({ method: "GET", url: "/api/server/ping" })
    assert.equal(missing.statusCode, 401)
    const wrong = await app.inject({
        method: "GET",
        url: "/api/server/ping",
        headers: { authorization: "Bearer not-the-token-aaaaaaaaaaaaaa" },
    })
    assert.equal(wrong.statusCode, 401)
    assert.deepEqual(JSON.parse(missing.body), JSON.parse(wrong.body),
        "missing vs wrong token must be indistinguishable")
    const right = await app.inject({
        method: "GET",
        url: "/api/server/ping",
        headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(right.statusCode, 200)
    const game = await app.inject({ method: "GET", url: "/api/index.php/tool/ping" })
    assert.equal(game.statusCode, 200, "game routes bypass the admin scope entirely")
    await app.close()
})

test("guard: every admin API plugin stays inside the adminApiScope in cn-server.ts", () => {
    const source = fs.readFileSync(path.join(repositoryRoot, "src/cn-server.ts"), "utf8")
    const scopeStart = source.indexOf("async function adminApiScope(scope)")
    assert.notEqual(scopeStart, -1, "adminApiScope must exist")
    // 截取作用域函数体（到下一个顶层 fastify.register 为止）
    const rest = source.slice(scopeStart)
    const nextRegister = rest.indexOf("fastify.register(", rest.indexOf("scope.register(") )
    const scopeBody = nextRegister === -1 ? rest : rest.slice(0, nextRegister)
    assert.match(scopeBody, /requireAdminApiToken\(scope/,
        "admin gate hook must be armed inside the scope")
    for (const plugin of ["indexWebApiPlugin", "seedsWebApiPlugin"]) {
        assert.match(
            scopeBody,
            new RegExp(`scope\\.register\\(${plugin}`),
            `${plugin} must register inside adminApiScope (outside = silent bypass)`,
        )
    }
    assert.ok(!/fastify\.register\(indexWebApiPlugin|fastify\.register\(seedsWebApiPlugin/.test(
        source.slice(0, scopeStart),
    ), "admin API plugins must not register on the root instance before the scope")
})
