"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("./test-workflow/bootstrap.cjs").bootstrap()

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

// TTL 兜底语义：短 TTL（500ms）下 share_room 注册的房立即可见、过期后从
// get_rooms 消失（房主异常退出未 disband 的兜底；正常生命周期由钩子续期）。
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "social-room-ttl-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
const previousTtl = process.env.SOCIAL_ROOM_SHARE_TTL_MS
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.SOCIAL_ROOM_SHARE_TTL_MS = "500"
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

let app
let multiContext
let host
let friend

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postMulti(url, payload) {
    const response = await app.inject({
        method: "POST",
        url: `/api/index.php/multi_battle_quest/${url}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
    return response
}

async function createPlayer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `social-room-ttl-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 780000000 + playerId
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
    multiContext = createEmbeddedMultiHttpContext()
    await app.register(async instance => {
        registerRoomRoutes(instance, multiContext)
        registerLobbyRoutes(instance, multiContext)
    }, { prefix: "/api/index.php/multi_battle_quest" })
    await app.ready()

    host = await createPlayer("host")
    friend = await createPlayer("friend")
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    for (const [key, previous] of [
        ["DATA_DIR", previousDataDirectory],
        ["MULTI_SOCIAL_DB_PATH", previousSocialDbPath],
        ["SOCIAL_ROOM_SHARE_TTL_MS", previousTtl],
    ]) {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
    }
})

const { upsertSharedFollowEdgeSync } = require("../src/data/domains/social-follow")

test("TTL 过期后房间从 get_rooms 消失（边界：恰等时刻不可见）", async () => {
    upsertSharedFollowEdgeSync(host.viewerId, friend.viewerId, Date.now())
    upsertSharedFollowEdgeSync(friend.viewerId, host.viewerId, Date.now())

    const created = await multiContext.coordinator.createRoom({
        requestId: `ttl-${Date.now()}`,
        participant: { nodeSessionId: "embedded", viewerId: host.viewerId },
        localPlayerId: host.playerId,
        partyId: 1,
        category: 2,
        questId: 2001,
        leaderCharacterId: 1010001,
        compatibility: {
            multiProtocolVersion: 1,
            APP_VER: "test",
            RES_VER: "test",
            cdnTargetVersion: "test",
            contentDigest: `sha256:${"0".repeat(64)}`,
            modeDigest: `sha256:${"1".repeat(64)}`,
        },
    })
    assert.ok(created.ok, JSON.stringify(created))
    const roomNumber = created.value.roomNumber

    const share = await postMulti("share_room", {
        viewer_id: host.viewerId,
        room_number: roomNumber,
        share_type_list: [1],
    })
    assert.equal(share.statusCode, 200)

    const before = decode(await postMulti("get_rooms", { viewer_id: friend.viewerId, party_id: 1, category_id: 2 }))
    assert.ok(before.data.rooms.some(entry => entry.room_number === roomNumber), "TTL 内可见")

    // 500ms TTL：服务端时间为秒截断，过期判定以秒为粒度。等待必须保证
    // 任何写入相位下读取都跨过至少一个秒界（TTL 500ms + 1500ms 裕量；
    // 800ms 会在写入落在秒前 ~200ms 相位时仍读同一秒，造成 ~20-30% 假失败）。
    // 恰等时刻不可见由 expires > now 的严格大于语义保证。
    await new Promise(resolve => setTimeout(resolve, 2000))
    const after = decode(await postMulti("get_rooms", { viewer_id: friend.viewerId, party_id: 1, category_id: 2 }))
    assert.equal(after.data.rooms.some(entry => entry.room_number === roomNumber), false, "TTL 过期后不可见")
})
