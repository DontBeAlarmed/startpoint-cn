"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

// 主库形态（默认部署）：不配 MULTI_SOCIAL_DB_PATH，social_follows 建在主库。
// 双形态按仓库惯例拆文件——本文件覆盖主库形态的双写与关系判定。
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "social-follows-main-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const followRoutes = require("../src/routes/api/follow").default
const {
    getSharedFollowRelationSync,
} = require("../src/data/domains/social-follow")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

let app
let viewerA
let viewerB
let viewerC

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postFollow(url, payload) {
    const response = await app.inject({
        method: "POST",
        url: `/api/index.php/follow/${url}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
    assert.equal(response.headers["content-type"], "application/x-msgpack", url)
    return response
}

async function createViewer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `social-follows-main-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 740000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    return { viewerId, playerId }
}

test.before(async () => {
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(followRoutes, { prefix: "/api/index.php/follow" })
    await app.ready()

    viewerA = (await createViewer("a")).viewerId
    viewerB = (await createViewer("b")).viewerId
    viewerC = (await createViewer("c")).viewerId
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousSocialDbPath === undefined) delete process.env.MULTI_SOCIAL_DB_PATH
    else process.env.MULTI_SOCIAL_DB_PATH = previousSocialDbPath
})

test("add 端点双写主库 social_follows，delete 端点移除该行", async () => {
    const added = decode(await postFollow("add", { viewer_id: viewerA, follow_id: viewerB }))
    assert.equal(added.data_headers.result_code, 1)
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "single")
    assert.equal(getSharedFollowRelationSync(viewerB, viewerA), "single")

    const removed = decode(await postFollow("delete", { viewer_id: viewerA, follow_id: viewerB }))
    assert.equal(removed.data_headers.result_code, 1)
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "none")
})

test("互相关注后关系判定为 mutual，任一方向单向都算 single", async () => {
    await postFollow("add", { viewer_id: viewerA, follow_id: viewerB })
    await postFollow("add", { viewer_id: viewerB, follow_id: viewerA })
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "mutual")
    assert.equal(getSharedFollowRelationSync(viewerB, viewerA), "mutual")

    await postFollow("delete", { viewer_id: viewerB, follow_id: viewerA })
    // A→B 仍在：B 视角（作为 follower 方向的反查）也满足 single
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "single")
    assert.equal(getSharedFollowRelationSync(viewerB, viewerA), "single")

    await postFollow("delete_followed", { viewer_id: viewerB, followed_id: viewerA })
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "none")
})

test("bulk_edit 按原始 viewer id 列表镜像增删", async () => {
    const bulk = decode(await postFollow("bulk_edit", {
        viewer_id: viewerA,
        add_follow_id_list: [viewerB, viewerC],
        delete_follow_id_list: [],
    }))
    assert.equal(bulk.data_headers.result_code, 1)
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "single")
    assert.equal(getSharedFollowRelationSync(viewerA, viewerC), "single")

    const bulk2 = decode(await postFollow("bulk_edit", {
        viewer_id: viewerA,
        add_follow_id_list: [],
        delete_follow_id_list: [viewerC],
    }))
    assert.equal(bulk2.data_headers.result_code, 1)
    assert.equal(getSharedFollowRelationSync(viewerA, viewerC), "none")
    assert.equal(getSharedFollowRelationSync(viewerA, viewerB), "single")
})

test("自关注不产生共享边", async () => {
    const selfAdd = decode(await postFollow("add", { viewer_id: viewerA, follow_id: viewerA }))
    assert.equal(selfAdd.data_headers.result_code, 1)
    assert.equal(getSharedFollowRelationSync(viewerA, viewerA), "none")
})

test("add 未知目标（400 路径）不触碰共享表", async () => {
    // 400 badRequest 走 JSON 分支（无 msgpack 头），绕过 postFollow helper 直接 inject
    const unknown = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: viewerA, follow_id: 740999999 }).toString("base64"),
    })
    assert.equal(unknown.statusCode, 400)
    assert.equal(getSharedFollowRelationSync(viewerA, 740999999), "none")
})
