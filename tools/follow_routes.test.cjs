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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "follow-routes-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getViewerIdSync } = require("../src/data/domains/session")
const followRoutes = require("../src/routes/api/follow").default
const {
    addLocalFollowSync,
} = require("../src/data/domains/follow")
const { getSocialCapacityPolicySync } = require("../src/lib/config-content")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

let app
let viewerA
let viewerB
let playerA
let playerB
let viewerEmpty

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
        idpId: `follow-routes-${tag}-${randomUUID()}`, status: "normal",
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

    const a = await createViewer("a")
    const b = await createViewer("b")
    const empty = await createViewer("empty")
    viewerA = a.viewerId
    viewerB = b.viewerId
    playerA = a.playerId
    playerB = b.playerId
    viewerEmpty = empty.viewerId
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("lists starts empty and add/delete drive the projected relation", async () => {
    const empty = decode(await postFollow("lists", { viewer_id: viewerEmpty }))
    assert.equal(empty.data_headers.result_code, 1)
    assert.deepEqual(empty.data.follow_info, [])
    assert.equal(empty.data.followed_count, 0)

    const addedResponse = await postFollow("add", { viewer_id: viewerA, follow_id: viewerB })
    assert.equal(addedResponse.statusCode, 200)
    assert.equal(decode(addedResponse).data_headers.result_code, 1)

    const listA = decode(await postFollow("lists", { viewer_id: viewerA }))
    assert.equal(listA.data.follow_info.length, 1)
    const entry = listA.data.follow_info[0]
    assert.equal(entry.viewer_id, viewerB)
    assert.equal(typeof entry.name, "string")
    assert.equal(typeof entry.rank, "number")
    assert.equal(typeof entry.degree_id, "number")
    assert.equal(typeof entry.role, "number")
    assert.equal(typeof entry.comment, "string")
    assert.equal(typeof entry.last_login_time, "number")
    assert.equal(entry.last_login_region, null)
    assert.equal(typeof entry.leader_character_id, "number")
    assert.equal(typeof entry.leader_character_evolution_img_level, "number")
    assert.equal(entry.follow_state, 2)
    assert.equal(typeof entry.follow_time, "number")
    assert.ok(entry.follow_time > 0)
    assert.equal(entry.followed_time, null)
    assert.equal(entry.profile_image_url, null)
    assert.equal(listA.data.followed_count, 0)

    // 对方视角：被关注
    const listB = decode(await postFollow("lists", { viewer_id: viewerB }))
    assert.equal(listB.data.follow_info[0].follow_state, 3)
    assert.equal(listB.data.followed_count, 1)

    // 互关
    await postFollow("add", { viewer_id: viewerB, follow_id: viewerA })
    const mutual = decode(await postFollow("lists", { viewer_id: viewerA }))
    assert.equal(mutual.data.follow_info[0].follow_state, 1)
    assert.notEqual(mutual.data.follow_info[0].follow_time, null)

    // delete → 回到无关系；重复 delete 幂等
    await postFollow("delete", { viewer_id: viewerB, follow_id: viewerA })
    await postFollow("delete", { viewer_id: viewerB, follow_id: viewerA })
    const afterDelete = decode(await postFollow("lists", { viewer_id: viewerA }))
    // B 取消了对 A 的关注；A→B 出边仍在 → A 视角 state=2
    assert.equal(afterDelete.data.follow_info[0].follow_state, 2)
})

test("search_id resolves same-server viewers only", async () => {
    const found = decode(await postFollow("search_id", { viewer_id: viewerA, search_id: viewerB }))
    assert.equal(found.data_headers.result_code, 1)
    assert.equal(found.data.search_result.viewer_id, viewerB)
    assert.equal(found.data.search_result.follow_state, 2)

    const missingResponse = await postFollow("search_id", { viewer_id: viewerA, search_id: 799999999 })
    assert.equal(missingResponse.statusCode, 200)
    const missing = decode(missingResponse)
    assert.equal(missing.data_headers.result_code, 1)
    assert.deepEqual(missing.data.search_result, {
        viewer_id: null,
        name: "",
        rank: 0,
        degree_id: 0,
        role: null,
        comment: "",
        last_login_time: null,
        last_login_region: null,
        leader_character_id: null,
        leader_character_evolution_img_level: null,
        follow_state: 0,
        follow_time: null,
        followed_time: null,
        profile_image_url: null,
    })
})

test("capacity limits answer with A-error result codes 1451 and 1452", async () => {
    const { maxFollows } = getSocialCapacityPolicySync()
    const over = await createViewer("over")
    const targets = []
    for (let index = 0; index < maxFollows; index++) {
        const target = await createViewer(`limit-t${index}`)
        targets.push(target)
        addLocalFollowSync({
            sourcePlayerId: over.playerId,
            targetPlayerId: target.playerId,
            followedAtMs: index,
        })
    }
    const extra = await createViewer("limit-extra")
    const limitedResponse = await postFollow("add", {
        viewer_id: over.viewerId, follow_id: extra.viewerId,
    })
    assert.equal(limitedResponse.statusCode, 200)
    assert.equal(decode(limitedResponse).data_headers.result_code, 1451)

    // 1452：目标被关注数达上限
    const star = await createViewer("star")
    const fans = []
    for (let index = 0; index < getSocialCapacityPolicySync().maxFollowers; index++) {
        const fan = await createViewer(`fan${index}`)
        fans.push(fan)
        addLocalFollowSync({
            sourcePlayerId: fan.playerId,
            targetPlayerId: star.playerId,
            followedAtMs: index,
        })
    }
    const late = await createViewer("late")
    const targetLimitedResponse = await postFollow("add", {
        viewer_id: late.viewerId, follow_id: star.viewerId,
    })
    assert.equal(targetLimitedResponse.statusCode, 200)
    assert.equal(decode(targetLimitedResponse).data_headers.result_code, 1452)
})

test("delete_followed removes the incoming edge and bulk_edit is atomic", async () => {
    const c = await createViewer("bulk-c")
    const d = await createViewer("bulk-d")
    const e = await createViewer("bulk-e")
    addLocalFollowSync({ sourcePlayerId: d.playerId, targetPlayerId: c.playerId, followedAtMs: 1 })
    addLocalFollowSync({ sourcePlayerId: e.playerId, targetPlayerId: c.playerId, followedAtMs: 2 })

    // c 删除粉丝 d
    const removed = decode(await postFollow("delete_followed", {
        viewer_id: c.viewerId, followed_id: d.viewerId,
    }))
    assert.equal(removed.data_headers.result_code, 1)
    const afterRemove = decode(await postFollow("lists", { viewer_id: c.viewerId }))
    assert.equal(afterRemove.data.follow_info.length, 1)
    assert.equal(afterRemove.data.follow_info[0].viewer_id, e.viewerId)

    // bulk_edit：加一人删一人
    const f = await createViewer("bulk-f")
    const bulk = decode(await postFollow("bulk_edit", {
        viewer_id: c.viewerId,
        add_follow_id_list: [f.viewerId],
        delete_follow_id_list: [e.viewerId],
    }))
    assert.equal(bulk.data_headers.result_code, 1)
    const afterBulk = decode(await postFollow("lists", { viewer_id: c.viewerId }))
    // e 仍是 c 的粉丝（bulk 的 delete_follow_id_list 只删出边）；
    // f 是新出边。按 last_login_time 降序。
    assert.deepEqual(
        afterBulk.data.follow_info.map(entry => entry.viewer_id).sort(),
        [e.viewerId, f.viewerId].sort(),
    )
})

test("self add, missing target and invalid viewer keep existing failure semantics", async () => {
    const selfResponse = await postFollow("add", { viewer_id: viewerA, follow_id: viewerA })
    assert.equal(selfResponse.statusCode, 200)
    assert.equal(decode(selfResponse).data_headers.result_code, 1, "自关注幂等成功不改状态")

    const missing = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: viewerA, follow_id: 799999998 }).toString("base64"),
    })
    assert.equal(missing.statusCode, 400, "无法解析的目标视作非法请求")

    const invalid = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: 799999997, follow_id: viewerB }).toString("base64"),
    })
    assert.equal(invalid.statusCode, 400)

    const badBody = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({}).toString("base64"),
    })
    assert.equal(badBody.statusCode, 400)
})
