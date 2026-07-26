"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const repositoryRoot = path.resolve(__dirname, "..")
const adminRuntimePath = path.join(repositoryRoot, "src/runtime/admin.ts")

function loadAdminRuntime() {
    assert.equal(fs.existsSync(adminRuntimePath), true, "required admin runtime module must exist")
    return require(adminRuntimePath)
}

function projectFixture(t, { withIndex = true } = {}) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-runtime-"))
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
    const distDir = path.join(projectRoot, "web/dist")
    fs.mkdirSync(path.join(distDir, "assets"), { recursive: true })
    if (withIndex) fs.writeFileSync(path.join(distDir, "index.html"), "<main>admin shell</main>")
    fs.writeFileSync(path.join(distDir, "assets/app.js"), "globalThis.admin = true")
    return projectRoot
}

test("runtime rejects startup when the required admin index is missing", t => {
    const { requireAdminBuild } = loadAdminRuntime()
    const missingRoot = projectFixture(t, { withIndex: false })

    assert.throws(() => requireAdminBuild(missingRoot), /admin.*web\/dist\/index\.html/i)
})

test("admin UI owns root, compatibility redirects, assets, and client routes", async t => {
    const { registerAdminUi } = loadAdminRuntime()
    const projectRoot = projectFixture(t)
    const app = Fastify({ logger: false })
    app.get("/api/ping", () => ({ source: "api" }))
    app.get("/public/ping", (_request, reply) => reply.type("text/plain").send("public"))
    app.get("/healthz", () => ({ status: "ready" }))
    registerAdminUi(app, { projectRoot })
    await app.ready()
    t.after(() => app.close())

    for (const [url, location] of [
        ["/", "/admin/"],
        ["/admin", "/admin/"],
        ["/player", "/admin/accounts"],
        ["/player/42", "/admin/players/42"],
        ["/mail", "/admin/mail"],
        ["/seeds", "/admin/seeds"],
    ]) {
        const response = await app.inject({ method: "GET", url })
        assert.equal(response.statusCode, 302, url)
        assert.equal(response.headers.location, location, url)
    }

    const clientRoute = await app.inject({ method: "GET", url: "/admin/accounts/active" })
    assert.equal(clientRoute.statusCode, 200)
    assert.match(clientRoute.headers["content-type"], /^text\/html/)
    assert.match(clientRoute.body, /admin shell/)

    const asset = await app.inject({ method: "GET", url: "/admin/assets/app.js" })
    assert.equal(asset.statusCode, 200)
    assert.match(asset.body, /globalThis\.admin/)

    for (const url of [
        "/admin/assets/missing",
        "/admin/assets/missing.js",
        "/admin/favicon.ico",
        "/admin/accounts/export.json",
    ]) {
        const missingAsset = await app.inject({ method: "GET", url })
        assert.equal(missingAsset.statusCode, 404, url)
        assert.doesNotMatch(missingAsset.body, /admin shell/, url)
    }
})

test("SPA fallback respects whether the client accepts HTML", async t => {
    const { registerAdminUi } = loadAdminRuntime()
    const app = Fastify({ logger: false })
    registerAdminUi(app, { projectRoot: projectFixture(t) })
    await app.ready()
    t.after(() => app.close())

    for (const headers of [
        { accept: "text/html" },
        { accept: "text/*" },
        undefined,
        { accept: "*/*" },
        { accept: "application/json, text/html;q=0.5" },
    ]) {
        const response = await app.inject({
            method: "GET",
            url: "/admin/accounts/active",
            headers,
        })
        assert.equal(response.statusCode, 200, headers?.accept ?? "missing Accept")
        assert.match(response.headers["content-type"], /^text\/html/)
        assert.match(response.body, /admin shell/)
    }

    for (const accept of [
        "application/json",
        "text/plain",
        "text/html;q=0",
        "text/*;q=0",
        "*/*;q=0",
        "text/html;q=0, */*;q=1",
        "text/html;q=0, text/*;q=1",
        "text/*;q=0, */*;q=1",
    ]) {
        const response = await app.inject({
            method: "GET",
            url: "/admin/accounts/active",
            headers: { accept },
        })
        assert.equal(response.statusCode, 404, accept)
        assert.match(response.headers["content-type"], /^application\/json/)
        assert.doesNotMatch(response.body, /admin shell/)
    }
})

test("SPA fallback never consumes game APIs, admin APIs, public assets, health, or non-GET requests", async t => {
    const { registerAdminUi } = loadAdminRuntime()
    const app = Fastify({ logger: false })
    app.get("/api/ping", () => ({ source: "api" }))
    app.get("/api/index.php/ping", () => ({ source: "game-api" }))
    app.get("/public/ping", () => "public")
    app.get("/healthz", () => ({ status: "ready" }))
    registerAdminUi(app, { projectRoot: projectFixture(t) })
    await app.ready()
    t.after(() => app.close())

    assert.deepEqual((await app.inject({ url: "/api/ping" })).json(), { source: "api" })
    assert.deepEqual((await app.inject({ url: "/api/index.php/ping" })).json(), { source: "game-api" })
    assert.equal((await app.inject({ url: "/public/ping" })).body, "public")
    assert.deepEqual((await app.inject({ url: "/healthz" })).json(), { status: "ready" })

    for (const request of [
        { method: "GET", url: "/api/index.php/missing" },
        { method: "GET", url: "/public/missing" },
        { method: "POST", url: "/admin/accounts" },
    ]) {
        const response = await app.inject(request)
        assert.equal(response.statusCode, 404, `${request.method} ${request.url}`)
        assert.doesNotMatch(response.body, /admin shell/)
    }
})

test("both server entries use the sole admin UI and legacy HTML sources are removed", () => {
    for (const entry of ["src/cn-server.ts", "src/server.ts"]) {
        const source = fs.readFileSync(path.join(repositoryRoot, entry), "utf8")
        assert.match(source, /registerAdminUi/)
        assert.doesNotMatch(source, /routes\/web(?:["']|\/)/)
    }
    assert.equal(fs.existsSync(path.join(repositoryRoot, "src/routes/web")), false)
    assert.equal(fs.existsSync(path.join(repositoryRoot, "web/pages")), false)

    assert.equal(fs.existsSync(path.join(repositoryRoot, "web/public/player.js")), false)
})

test("legacy admin Tailwind build chain and assets are removed", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
    assert.equal(packageJson.scripts.css, undefined)
    assert.equal(packageJson.scripts["css:watch"], undefined)
    assert.equal(packageJson.dependencies.tailwindcss, undefined)
    assert.equal(packageJson.scripts.debug, "npm run debug:ts-only")

    for (const legacyPath of [
        "src/input.css",
        "tailwind.config.js",
        "web/public/tailwind.css",
        "web/public/font",
        "web/public/img/logo.png",
    ]) {
        assert.equal(fs.existsSync(path.join(repositoryRoot, legacyPath)), false, legacyPath)
    }

    const vscodeTasks = fs.readFileSync(path.join(repositoryRoot, ".vscode/tasks.json"), "utf8")
    assert.doesNotMatch(vscodeTasks, /npm run css|CSS watch|Build CSS/)

    const devcontainer = fs.readFileSync(path.join(repositoryRoot, ".devcontainer/devcontainer.json"), "utf8")
    assert.doesNotMatch(devcontainer, /tailwind/i)
})

test("operator copy and embedded docs describe one required built-in admin", () => {
    const dashboard = fs.readFileSync(path.join(repositoryRoot, "admin/src/pages/Dashboard.tsx"), "utf8")
    assert.match(dashboard, /唯一内置管理后台/)
    assert.doesNotMatch(dashboard, /新版 React 管理后台|旧后台页面保持冻结/)

    const embeddedContract = fs.readFileSync(path.join(repositoryRoot, "docs/embedded-runtime-contract.md"), "utf8")
    assert.match(embeddedContract, /必需管理后台产物/)
    assert.doesNotMatch(embeddedContract, /可选管理后台产物/)
})
