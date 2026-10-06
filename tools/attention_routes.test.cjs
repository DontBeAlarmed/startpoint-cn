"use strict"

// A1 铃铛路由契约回归：
// - /attention/check 响应 data.multi[i] 必须与客户端强校验器
//   （AttentionCheckRealRemoteService）的 9 字段 quest_info 完全一致；
// - check 轮询即 presence 上报；
// - 读时惰性投递：guest 首次轮询即收到 open 招募，accepted 后收敛；
// - /attention/action 是"参加优先度评分"端点（非 accept/decline）。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "attention-routes-db-"))
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { addLocalFollowSync } = require("../src/data/domains/follow")
const {
    buildEstablisherSnapshot,
    getOrCreateRecruitmentForRoom,
} = require("../src/data/domains/attention")
const { isPresenceOnline } = require("../src/multi/presence")
const { getServerTime } = require("../src/utils")
const { createRoom } = require("../src/multi/room/manager")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { registerRoomRoutes } = require("../src/multi/http/room")

initializeDatabase()
db = getDb()

let playerSeq = 0
async function createPlayer() {
    playerSeq += 1
    const viewerId = 850000000 + playerSeq
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `attention-${playerSeq}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}

async function main() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    const { default: attentionRoutes } = require("../src/routes/api/attention")
    await fastify.register(attentionRoutes, { prefix: "/api/index.php/attention" })
    const multiContext = createEmbeddedMultiHttpContext()
    await fastify.register(
        async instance => { registerRoomRoutes(instance, multiContext) },
        { prefix: "/api/index.php/multi_battle_quest" },
    )
    await fastify.ready()

    const host = await createPlayer()
    const guest = await createPlayer()

    // ---- 400：非法 viewer_id / 无会话 ----
    assert.equal((await post(fastify, "/api/index.php/attention/check", {
        viewer_id: 0, holding_number: 0, retry_count: 0, request_number: 3,
    })).statusCode, 400)
    assert.equal((await post(fastify, "/api/index.php/attention/check", {
        viewer_id: 999999999, holding_number: 0, retry_count: 0, request_number: 3,
    })).statusCode, 400, "无会话 viewer 必须拒绝")

    // ---- 房主开招募（share_room 接线的域层落点） ----
    const recruitment = getOrCreateRecruitmentForRoom({
        hostPid: host.playerId,
        hostViewerId: host.viewerId,
        category: 1,
        questId: 1001001,
        roomNumber: "345678",
        isNewbieHost: true,
        establisherJson: buildEstablisherSnapshot({
            character: 341005,
            rankLevel: 42,
            hostEntryTime: 1700,
        }),
        nowMs: getServerTime() * 1000,
    })

    // ---- guest 轮询 check：收到铃铛，字段集与客户端契约一致 ----
    const checked = await post(fastify, "/api/index.php/attention/check", {
        viewer_id: guest.viewerId, holding_number: 1, retry_count: 0, request_number: 3,
    })
    assert.equal(checked.statusCode, 200, checked.body)
    const data = unpack(Buffer.from(checked.body, "base64")).data
    assert.ok(data.config !== null && typeof data.config === "object", "config 块必须保留")
    assert.equal(data.config.return_attention_max_num, 3)
    assert.ok(Array.isArray(data.multi), "multi 必须是数组（缺失/为 null 时客户端按无铃铛处理）")
    assert.equal(data.multi.length, 1)
    const bell = data.multi[0]
    assert.equal(bell.attention_key, recruitment.attentionKey)
    assert.deepEqual(
        Object.keys(bell.quest_info).sort(),
        [
            "category_id",
            "establisher_character",
            "establisher_character_evolution_img_level",
            "establisher_follow",
            "establisher_rank",
            "host_entry_time",
            "is_newbie",
            "quest_id",
            "room_number",
        ],
        "quest_info 字段集必须与 AttentionCheckRealRemoteService 强校验一致",
    )
    assert.equal(bell.quest_info.category_id, 1)
    assert.equal(bell.quest_info.quest_id, 1001001)
    assert.equal(bell.quest_info.room_number, "345678")
    assert.equal(bell.quest_info.is_newbie, true)
    assert.equal(bell.quest_info.establisher_character, 341005)
    assert.equal(bell.quest_info.establisher_rank, 42)
    assert.equal(bell.quest_info.host_entry_time, 1700)
    assert.equal(bell.quest_info.establisher_follow, 0, "无关注关系时为 0")

    // ---- check 轮询即 presence 上报 ----
    assert.equal(isPresenceOnline(guest.viewerId), true, "check 轮询必须 touch presence")

    // ---- guest 关注房主后，establisher_follow 实时投影（F0 语义：2=我→对方单向） ----
    addLocalFollowSync({
        sourcePlayerId: guest.playerId,
        targetPlayerId: host.playerId,
        followedAtMs: Date.now(),
    })
    const refollowed = unpack(Buffer.from((await post(fastify, "/api/index.php/attention/check", {
        viewer_id: guest.viewerId, holding_number: 2, retry_count: 0, request_number: 3,
    })).body, "base64")).data
    assert.equal(refollowed.multi[0].quest_info.establisher_follow, 2, "单向关注投影 establisher_follow=2")

    // ---- 互关后投影 1（与房间 join 路径同源：getLocalFollowRelationSync().state） ----
    addLocalFollowSync({
        sourcePlayerId: host.playerId,
        targetPlayerId: guest.playerId,
        followedAtMs: Date.now(),
    })
    const mutual = unpack(Buffer.from((await post(fastify, "/api/index.php/attention/check", {
        viewer_id: guest.viewerId, holding_number: 3, retry_count: 0, request_number: 3,
    })).body, "base64")).data
    assert.equal(mutual.multi[0].quest_info.establisher_follow, 1, "互关投影 establisher_follow=1")

    // ---- 房主自己看不到自己的招募 ----
    const hostCheck = unpack(Buffer.from((await post(fastify, "/api/index.php/attention/check", {
        viewer_id: host.viewerId, holding_number: 1, retry_count: 0, request_number: 3,
    })).body, "base64")).data
    assert.equal(hostCheck.multi.length, 0, "房主不得收到自己的铃铛")

    // ---- 惰性投递：guest 再次轮询不重复、accepted 后收敛 ----
    const deliveries = db.prepare(
        "SELECT COUNT(*) AS n FROM attention_deliveries WHERE viewer_id = ?"
    ).get(guest.viewerId)
    assert.equal(deliveries.n, 1, "重复轮询不得产生重复投递行")

    // ---- /attention/action：参加优先度评分（客户端强校验两个 Float） ----
    const action = await post(fastify, "/api/index.php/attention/action", {
        viewer_id: guest.viewerId,
        priority_factors: ["Receive"],
        api_count: 1,
    })
    assert.equal(action.statusCode, 200, action.body)
    const actionData = unpack(Buffer.from(action.body, "base64")).data
    assert.deepEqual(Object.keys(actionData).sort(), ["priority_action_score", "priority_playing_score"])
    assert.equal(typeof actionData.priority_action_score, "number")
    assert.equal(typeof actionData.priority_playing_score, "number")

    // ---- /attention/logger：丢弃日志，返回空对象 ----
    const logged = await post(fastify, "/api/index.php/attention/logger", {
        viewer_id: guest.viewerId,
        client_logs: [{
            log_type: "Receive",
            scene_view: "",
            attention_key: recruitment.attentionKey,
            category_id: 1,
            quest_id: 1001001,
            room_number: "345678",
            timestamp: 1700,
        }],
        api_count: 1,
    })
    assert.equal(logged.statusCode, 200, logged.body)

    // ---- action/logger 的 400 ----
    assert.equal((await post(fastify, "/api/index.php/attention/action", {
        viewer_id: 0, priority_factors: [], api_count: 1,
    })).statusCode, 400)
    assert.equal((await post(fastify, "/api/index.php/attention/logger", {
        viewer_id: 0, client_logs: [], api_count: 1,
    })).statusCode, 400)

    // ---- share_room 类型门控：仅 share_type_list 含 3（随机招募）才落招募行 ----
    // 客户端契约（MultiBattleRoomScene.shareRequestAPI / AttentionRecruitmentRedeliverTimer）：
    // 含 3 时移出列表走 startRecruit 定时器（重发恒为 [3]）；纯 [1]/[2]（互关/粉丝）
    // 一次性分享不得把房间广播成随机招募铃铛。
    const shareGateHost = await createPlayer()
    const shareRoom = createRoom(
        shareGateHost.viewerId, shareGateHost.playerId, 1, 1, 1001001, 0, 341005,
    )
    const shareUrl = "/api/index.php/multi_battle_quest/share_room"
    const recruitmentCount = () => db.prepare(
        "SELECT COUNT(*) AS n FROM attention_recruitments WHERE room_number = ?"
    ).get(shareRoom.room_number).n

    for (const shareTypeList of [[1, 2], [1], [2]]) {
        const shared = await post(fastify, shareUrl, {
            viewer_id: shareGateHost.viewerId,
            room_number: shareRoom.room_number,
            share_type_list: shareTypeList,
            api_count: 1,
        })
        assert.equal(shared.statusCode, 200, shared.body)
        assert.equal(recruitmentCount(), 0, `纯 ${JSON.stringify(shareTypeList)} 分享不得创建招募行`)
    }

    const noList = await post(fastify, shareUrl, {
        viewer_id: shareGateHost.viewerId,
        room_number: shareRoom.room_number,
        api_count: 2,
    })
    assert.equal(noList.statusCode, 200, noList.body)
    assert.equal(recruitmentCount(), 0, "缺省 share_type_list 不得创建招募行")

    const recruited = await post(fastify, shareUrl, {
        viewer_id: shareGateHost.viewerId,
        room_number: shareRoom.room_number,
        share_type_list: [3],
        api_count: 3,
    })
    assert.equal(recruited.statusCode, 200, recruited.body)
    assert.equal(recruitmentCount(), 1, "share_type_list 含 3 必须创建招募行")
    const gateRow = db.prepare(
        "SELECT attention_key FROM attention_recruitments WHERE room_number = ?"
    ).get(shareRoom.room_number)
    assert.match(gateRow.attention_key, new RegExp(`^attention_\\d{6}_${shareGateHost.viewerId}$`))

    // 重发 [3] 幂等：同房间仍是一行、同一 key
    await post(fastify, shareUrl, {
        viewer_id: shareGateHost.viewerId,
        room_number: shareRoom.room_number,
        share_type_list: [3],
        api_count: 4,
    })
    assert.equal(recruitmentCount(), 1, "重发 [3] 不得创建新行")
    assert.equal(
        db.prepare("SELECT attention_key FROM attention_recruitments WHERE room_number = ?")
            .get(shareRoom.room_number).attention_key,
        gateRow.attention_key,
        "重发 [3] 不得更换 attention_key",
    )

    console.log("attention routes: all assertions passed")
    await fastify.close()
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
