"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

console.error("[SF-DEBUG] module: before snapshot install")
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
console.error("[SF-DEBUG] module: snapshot installed")
test.after(() => restoreContentSnapshot())

// 共享形态：MULTI_SOCIAL_DB_PATH 指向独立共享文件，用两个独立连接模拟
// 两个节点进程——节点 A 写 follow 边，节点 B 无需重启即可读到关系判定
//（好友房间大厅可见性过滤的跨节点语义）。
const sharedDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "social-follows-shared-")), "social.sqlite")
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "social-follows-shared-node-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
process.env.MULTI_SOCIAL_DB_PATH = sharedDbPath
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const sqlite3 = require("better-sqlite3")
const { getSharedFollowRelationSync } = require("../src/data/domains/social-follow")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

console.error("[SF-DEBUG] module: before initializeDatabase")
data.initializeDatabase()
console.error("[SF-DEBUG] module: database initialized")

test.after(async () => {
    data.closeDatabase()
    fs.rmSync(path.dirname(sharedDbPath), { recursive: true, force: true })
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousSocialDbPath === undefined) delete process.env.MULTI_SOCIAL_DB_PATH
    else process.env.MULTI_SOCIAL_DB_PATH = previousSocialDbPath
})

function makeViewerPair(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `social-follows-shared-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    return { viewerId: 740000000 + playerId, playerId, account }
}

test("共享形态：本模块写共享文件，第二连接（模拟节点 B）读到同一行", () => {
    console.error("[SF-DEBUG] enter: 共享形态：本模块写共享文件，第二连接（模拟节点 B）读到同一行")
    const a = makeViewerPair("a")
    const b = makeViewerPair("b")
    const { upsertSharedFollowEdgeSync } = require("../src/data/domains/social-follow")

    upsertSharedFollowEdgeSync(a.viewerId, b.viewerId, 1700000000000)

    // 节点 B：独立打开同一共享文件（不同连接句柄）
    const nodeB = new sqlite3(sharedDbPath)
    nodeB.pragma("journal_mode = WAL")
    const rows = nodeB.prepare(`
        SELECT follower_viewer_id, followed_viewer_id FROM social_follows
        WHERE follower_viewer_id = ? AND followed_viewer_id = ?
    `).all(a.viewerId, b.viewerId)
    nodeB.close()
    assert.equal(rows.length, 1)

    // 同进程读 API 判定 single
    assert.equal(getSharedFollowRelationSync(a.viewerId, b.viewerId), "single")
})

test("共享形态：双行 mutual / 单行 single / 零行 none", () => {
    console.error("[SF-DEBUG] enter: 共享形态：双行 mutual / 单行 single / 零行 none")
    const a = makeViewerPair("m")
    const b = makeViewerPair("n")
    const { upsertSharedFollowEdgeSync, deleteSharedFollowEdgeSync } = require("../src/data/domains/social-follow")

    upsertSharedFollowEdgeSync(a.viewerId, b.viewerId, 1700000000000)
    assert.equal(getSharedFollowRelationSync(b.viewerId, a.viewerId), "single")
    upsertSharedFollowEdgeSync(b.viewerId, a.viewerId, 1700000000000)
    assert.equal(getSharedFollowRelationSync(b.viewerId, a.viewerId), "mutual")
    deleteSharedFollowEdgeSync(b.viewerId, a.viewerId)
    assert.equal(getSharedFollowRelationSync(b.viewerId, a.viewerId), "single")
    deleteSharedFollowEdgeSync(a.viewerId, b.viewerId)
      console.error("[SF-DEBUG] enter: 共享库不可用时 follow add 端点仍成功（双写降级 WARN，本地权威不受影响）")
  assert.equal(getSharedFollowRelationSync(b.viewerId, a.viewerId), "none")
})

test("共享库不可用时 follow add 端点仍成功（双写降级 WARN，本地权威不受影响）", async () => {
    const { resetSharedSocialDbForTest } = require("../src/data/social/shared-db")
    resetSharedSocialDbForTest()
    const previousPath = process.env.MULTI_SOCIAL_DB_PATH
    process.env.MULTI_SOCIAL_DB_PATH = "/proc/definitely-not-writable/social.sqlite"
    try {
        const Fastify = require("fastify")
        const app = Fastify({ logger: false })
        app.addContentTypeParser(
            "application/x-www-form-urlencoded",
            { parseAs: "string" },
            (_request, body, done) => done(null, require("msgpackr").unpack(Buffer.from(body, "base64"))),
        )
        const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
        registerCnMsgpackOnSend(app)
        const { registerFollowWriteRoutes } = require("../src/routes/api/follow/write-routes")
        await app.register(async instance => {
            registerFollowWriteRoutes(instance)
        }, { prefix: "/api/index.php/follow" })
        await app.ready()

        const self = makeViewerPair("degrade-self")
        const target = makeViewerPair("degrade-target")
        const viewerId = self.viewerId
        await insertSessionWithToken({
            token: String(viewerId), accountId: self.account.id,
            expires: new Date("2099-01-01"), type: SessionType.VIEWER,
        })
        await insertSessionWithToken({
            token: String(target.viewerId), accountId: target.account.id,
            expires: new Date("2099-01-01"), type: SessionType.VIEWER,
        })

        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/follow/add",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: require("msgpackr").pack({
                viewer_id: viewerId,
                follow_id: target.viewerId,
            }).toString("base64"),
        })
        assert.equal(response.statusCode, 200, "共享写失败必须降级，不得 500")
        const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
        assert.equal(payload.data_headers.result_code, 1, "本地权威写成功")
    } finally {
        process.env.MULTI_SOCIAL_DB_PATH = previousPath
        resetSharedSocialDbForTest()
    }
})

test("共享库不可用时 relation fail-closed 为 none", () => {
    console.error("[SF-DEBUG] enter: 共享库不可用时 relation fail-closed 为 none")
    // 重置共享库单例并指向不可写路径，使连接打开失败
    const { resetSharedSocialDbForTest } = require("../src/data/social/shared-db")
    resetSharedSocialDbForTest()
    const previousPath = process.env.MULTI_SOCIAL_DB_PATH
    process.env.MULTI_SOCIAL_DB_PATH = "/proc/definitely-not-writable/social.sqlite"
    try {
        const a = 740000901
        const b = 740000902
        assert.equal(getSharedFollowRelationSync(a, b), "none")
    } finally {
        process.env.MULTI_SOCIAL_DB_PATH = previousPath
        resetSharedSocialDbForTest()
    }
})
