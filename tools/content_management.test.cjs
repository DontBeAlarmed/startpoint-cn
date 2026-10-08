"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

// 主库形态（content-management 只读快照，注册表无关）
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "content-management-"))
const previousDataDirectory = process.env.DATA_DIR
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { registerContentManagementRoutes } = require("../src/routes/web_api/content-management")
const { resetMediumArchiveIndexes } = require("../src/content/cdn/medium-archive-index")

data.initializeDatabase()

let app
let runSyncCalls
let runSyncImpl
let reloadImpl
let lastReloadError

function decode(response) {
    return JSON.parse(response.body)
}

test.before(async () => {
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    await app.register(async instance => {
        registerContentManagementRoutes(instance, {
        prefix: "/api/content-management",
        getGameCalendarUtcOffsetMinutes: () => 480,
        runSync: async options => {
            runSyncCalls.push(options)
            return runSyncImpl(options)
        },
        reload: async () => {
            if (lastReloadError) throw lastReloadError
            resetMediumArchiveIndexes()
            // 模拟热重载语义：原子替换生产 provider 的快照引用（新 targetVersion）
            const runtime = require("../src/content/runtime/content-snapshot")
            const previous = runtime.getContentSnapshot()
            const current = {
                ...previous,
                cdn: { ...previous.cdn, targetVersion: "1.4.55" },
            }
            runtime.productionContentSnapshotProvider.snapshot = current
            return { previous, current }
        },
        })
    }, { prefix: "/api/content-management" })
    await app.ready()
    runSyncCalls = []
    runSyncImpl = async () => ({
        status: "synchronized",
        action: "synchronize",
        targetVersion: "1.4.55",
        currentVersion: "1.4.54",
        reason: "source-state",
        releaseDigest: `sha256:${"a".repeat(64)}`,
    })
    reloadImpl = null
    lastReloadError = null
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("GET /state 返回当前内容版本与 busy 标志", async () => {
    const response = await app.inject({ method: "GET", url: "/api/content-management/state" })
    assert.equal(response.statusCode, 200)
    const payload = decode(response)
    assert.equal(typeof payload.targetVersion, "string")
    assert.ok(payload.contentDigest === null || typeof payload.contentDigest === "string")
    assert.equal(payload.busy, false)
    assert.equal(payload.appliedAt, null)
})

test("apply 成功：sync → reload 串联并返回新旧版本", async () => {
    const response = await app.inject({
        method: "POST",
        url: "/api/content-management/apply",
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    const payload = decode(response)
    assert.equal(payload.data.applied, true)
    assert.equal(payload.data.currentVersion, "1.4.55")
    assert.equal(runSyncCalls.length, 1)
    assert.equal(runSyncCalls[0].mode, "force")
    assert.equal(runSyncCalls[0].gameCalendarUtcOffsetMinutes, 480, "日历偏移必须来自注入的启动锁定值")
})

test("apply 期间并发调用返回 409", async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    runSyncImpl = () => gate
    const first = app.inject({ method: "POST", url: "/api/content-management/apply", payload: {} })
    // 让 first 的 handler 进入 await gate（注册表挂起）后再发并发请求
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const second = await app.inject({ method: "POST", url: "/api/content-management/apply", payload: {} })
    assert.equal(second.statusCode, 409)
    const secondBody = decode(second)
    assert.equal(secondBody.code, "APPLY_IN_PROGRESS")
    assert.ok(secondBody.error, "409 必须带 error 字段（admin client 提取惯例）")

    release()
    const firstResponse = await first
    assert.equal(firstResponse.statusCode, 200)
})

test("sync 失败返回结构化结果（applied:false, stage:sync），不 500", async () => {
    runSyncImpl = async () => { throw new Error("content sync exploded") }
    const response = await app.inject({ method: "POST", url: "/api/content-management/apply", payload: {} })
    assert.equal(response.statusCode, 200)
    const payload = decode(response)
    assert.equal(payload.data.applied, false)
    assert.equal(payload.data.stage, "sync")
    assert.ok(payload.data.note.includes("content sync exploded"))
})

test("reload 失败返回结构化结果（applied:false, stage:reload）并附跳版警示", async () => {
    runSyncImpl = async () => ({
        status: "synchronized",
        action: "synchronize",
        targetVersion: "1.4.55",
        currentVersion: "1.4.54",
        reason: "source-state",
    })
    lastReloadError = new Error("reload exploded")
    const response = await app.inject({ method: "POST", url: "/api/content-management/apply", payload: {} })
    assert.equal(response.statusCode, 200)
    const payload = decode(response)
    assert.equal(payload.data.applied, false)
    assert.equal(payload.data.stage, "reload")
    assert.ok(payload.data.note.includes("重启将生效新版本"), "必须警示跳版/重启行为")
    lastReloadError = null
})
