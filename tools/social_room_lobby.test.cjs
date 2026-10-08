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

// 主库形态：share_room 位掩码持久化 + get_rooms 可见性矩阵 + 投影强校验。
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "social-room-lobby-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { registerFollowWriteRoutes: registerFollowRoutes } = require("../src/routes/api/follow/write-routes")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { setRoomBattle, disbandRoom } = require("../src/multi/room/manager")
const { getRoomShareRowSync: readRow } = require("../src/data/domains/social-room-shares")
const { upsertSharedFollowEdgeSync } = require("../src/data/domains/social-follow")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

// 解散钩子（注册行 DELETE）在服务器启动时由 runtime service 安装；
// 测试进程必须显式安装，否则 disbandRoom 不会触发行清理。
require("../src/multi/room/disband-listener").installDisbandLifecycleListener()

let app
let multiContext
let host
let mutualFriend
let oneWayFriend
let stranger

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
        idpId: `social-room-lobby-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 760000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    return { viewerId, playerId }
}

let roomSeq = 0
async function makeRoom(hostInfo) {
    roomSeq += 1
    // 走 coordinator.createRoom（登记 host 身份映射，share_room 房主校验需要），
    // 但跳过 HTTP 兼容指纹层（测试裸请求头无客户端指纹）。进房权威校验不在本测试范围。
    const result = await multiContext.coordinator.createRoom({
        requestId: `social-lobby-${roomSeq}`,
        participant: {
            nodeSessionId: "embedded",
            viewerId: hostInfo.viewerId,
        },
        localPlayerId: hostInfo.playerId,
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
    assert.ok(result.ok, JSON.stringify(result))
    return result.value
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
    updatePlayerSync({ id: host.playerId, name: "HostLobby" })
    mutualFriend = await createPlayer("mutual")
    oneWayFriend = await createPlayer("oneway")
    stranger = await createPlayer("stranger")

    // host ↔ mutualFriend 互关；oneWayFriend → host 单向；stranger 无关系
    upsertSharedFollowEdgeSync(host.viewerId, mutualFriend.viewerId, Date.now())
    upsertSharedFollowEdgeSync(mutualFriend.viewerId, host.viewerId, Date.now())
    upsertSharedFollowEdgeSync(oneWayFriend.viewerId, host.viewerId, Date.now())
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

async function shareAsHost(room, shareTypeList) {
    return postMulti("share_room", {
        viewer_id: host.viewerId,
        room_number: room.roomNumber,
        share_type_list: shareTypeList,
    })
}

async function getRooms(viewerId, categoryId = 2) {
    const response = await postMulti("get_rooms", { viewer_id: viewerId, party_id: 1, category_id: categoryId })
    assert.equal(response.statusCode, 200)
    const payload = decode(response)
    return payload.data.rooms
}

function findRoom(rooms, roomNumber) {
    return rooms.find(entry => entry.room_number === roomNumber)
}

test("双向关注房（[1]）：仅互关好友可见", async () => {
    const room = await makeRoom(host)
    const share = await shareAsHost(room, [1])
    assert.equal(share.statusCode, 200)

    const mutualRooms = await getRooms(mutualFriend.viewerId)
    assert.ok(findRoom(mutualRooms, room.roomNumber), "互关好友必须可见")

    const oneWayRooms = await getRooms(oneWayFriend.viewerId)
    assert.equal(findRoom(oneWayRooms, room.roomNumber), undefined, "单向关注者不可见双向房")

    const strangerRooms = await getRooms(stranger.viewerId)
    assert.equal(findRoom(strangerRooms, room.roomNumber), undefined, "无关系者不可见")
})

test("单向关注房（[2]）：互关与单向都可见，无关系不可见", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [2])

    assert.ok(findRoom(await getRooms(mutualFriend.viewerId), room.roomNumber), "互关可见单向房")
    assert.ok(findRoom(await getRooms(oneWayFriend.viewerId), room.roomNumber), "单向（关注了房主）可见单向房")
    assert.equal(findRoom(await getRooms(stranger.viewerId), room.roomNumber), undefined, "无关系不可见")
})

test("混合（[1,2]）：全关系可见；OR-merge 后 [1] 不被 [2] 收缩", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [1])
    await shareAsHost(room, [2])

    const row = readRow(room.roomNumber)
    assert.equal(row.share_bits & 1, 1, "bit1 不得被后续 [2] 收缩")
    assert.equal(row.share_bits & 2, 2)

    assert.ok(findRoom(await getRooms(mutualFriend.viewerId), room.roomNumber))
    assert.ok(findRoom(await getRooms(oneWayFriend.viewerId), room.roomNumber))
})

test("纯随机招募 [3] 不进列表；[1] 后接 [3] 铃铛重发行仍在（P0 回归）", async () => {
    const randomOnly = await makeRoom(host)
    await shareAsHost(randomOnly, [3])
    assert.equal(readRow(randomOnly.roomNumber), undefined, "[3] 不得触碰注册表")
    assert.equal(findRoom(await getRooms(mutualFriend.viewerId), randomOnly.roomNumber), undefined)

    const hybrid = await makeRoom(host)
    await shareAsHost(hybrid, [1])
    await shareAsHost(hybrid, [3])
    const row = readRow(hybrid.roomNumber)
    assert.ok(row, "[3] 重发不得删除注册行")
    assert.equal(row.share_bits & 1, 1, "[3] 重发不得收缩位")
    assert.ok(findRoom(await getRooms(mutualFriend.viewerId), hybrid.roomNumber), "[1,3] 混合房仍对互关好友可见")

    // 空列表与未知数值（[7]）：bits=0 → 不得触碰注册行、响应仍 200（双审补测）
    const emptyShare = await makeRoom(host)
    const emptyResponse = await shareAsHost(emptyShare, [])
    assert.equal(emptyResponse.statusCode, 200)
    assert.equal(readRow(emptyShare.roomNumber), undefined)

    const unknownValue = await makeRoom(host)
    const unknownResponse = await shareAsHost(unknownValue, [7])
    assert.equal(unknownResponse.statusCode, 200)
    assert.equal(readRow(unknownValue.roomNumber), undefined, "未知数值不得建行")
})

test("raising_state=4（战斗中）仍在列表（好友可见战斗中状态，客户端灰显）", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [1])
    assert.ok(setRoomBattle(room.roomNumber), "状态机应允许 Filled→Battle")

    const rooms = await getRooms(mutualFriend.viewerId)
    const entry = findRoom(rooms, room.roomNumber)
    assert.ok(entry, "战斗中的房仍在列表")
    assert.equal(entry.raising_state, 4)
})

test("解散后注册行消失", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [1])
    assert.ok(readRow(room.roomNumber), "分享后行存在")
    disbandRoom(room.roomNumber)
    assert.equal(readRow(room.roomNumber), undefined, "解散删行")
})

test("category 不匹配不可见", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [1])
    const otherCategory = await getRooms(mutualFriend.viewerId, 3)
    assert.equal(findRoom(otherCategory, room.roomNumber), undefined)
    assert.ok(findRoom(await getRooms(mutualFriend.viewerId, 2), room.roomNumber))
})

test("投影 11 字段类型逐个断言（模拟客户端强校验）", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [1])
    const entry = findRoom(await getRooms(mutualFriend.viewerId), room.roomNumber)
    assert.ok(entry, "条目存在")
    assert.equal(typeof entry.category_id, "number")
    assert.equal(typeof entry.quest_id, "number")
    assert.equal(typeof entry.room_number, "string")
    assert.equal(typeof entry.establisher_name, "string")
    assert.notEqual(entry.establisher_name, "")
    assert.equal(entry.establisher_name, "HostLobby", "房主真名必须来自快照（双审 P0：parse 端丢字段会让兜底值蒙混过关）")
    assert.ok(Number(entry.establisher_character_evolution_img_level) >= 0)
    assert.equal(typeof entry.establisher_character, "number")
    assert.equal(typeof entry.establisher_character_evolution_img_level, "number")
    assert.equal(typeof entry.establisher_follow, "number")
    assert.equal(entry.establisher_follow, 1)
    assert.equal(typeof entry.host_entry_time, "number")
    assert.equal(typeof entry.mates, "number")
    assert.ok(entry.mates >= 1, "mates 至少含房主")
    assert.equal(typeof entry.raising_state, "number")
    assert.equal(typeof entry.is_pickup, "boolean")
    assert.equal(entry.is_pickup, false)
})

test("establisher_follow 徽章与过滤同源：单向关注者的视图徽章为 0", async () => {
    const room = await makeRoom(host)
    await shareAsHost(room, [2])
    const mutualEntry = findRoom(await getRooms(mutualFriend.viewerId), room.roomNumber)
    assert.equal(mutualEntry.establisher_follow, 1)
    const oneWayEntry = findRoom(await getRooms(oneWayFriend.viewerId), room.roomNumber)
    assert.equal(oneWayEntry.establisher_follow, 0)
})
