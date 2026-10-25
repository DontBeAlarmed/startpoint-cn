"use strict"

// R-G04 回归：领主战参加门——创建/加入 boss 任务房间时，加入者（含房主）的
// 任务进度必须满足 viewable 前置链（boss_battle_join_gates.json 派生）。
// 真实数据链：1001002 ← 主线 6010004；1001003 ← boss 1001002；1001001/1001005 无门。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-join-gate-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { isBossQuestJoinAllowed } = require("../src/lib/boss-join-gate")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { registerRoomRoutes } = require("../src/multi/http/room")
const { registerLobbyRoutes } = require("../src/multi/http/lobby")

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}
process.once("exit", cleanup)

data.initializeDatabase()
const db = getDb()

let playerSeq = 0
async function createPlayer(label) {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `boss-gate-${label}-${playerSeq}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 860000000 + playerSeq
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function setProgress(playerId, section, questId) {
    db.prepare(`
        INSERT INTO players_quest_progress (section, quest_id, finished, player_id)
        VALUES (?, ?, 1, ?)
    `).run(section, questId, playerId)
}

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

let fastify
test.before(async () => {
    fastify = Fastify({ logger: false })
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
    // 固定兼容剖面：请求不带 APP_VER/RES_VER 头时 getCompatibility 直接放行
    const multiContext = createEmbeddedMultiHttpContext({
        compatibility: Object.freeze({
            multiProtocolVersion: 1,
            APP_VER: "embedded",
            RES_VER: "embedded",
            cdnTargetVersion: "embedded",
            contentDigest: `sha256:${"0".repeat(64)}`,
            modeDigest: `sha256:${"0".repeat(64)}`,
        }),
    })
    await fastify.register(
        async instance => {
            registerLobbyRoutes(instance, multiContext)
            registerRoomRoutes(instance, multiContext)
        },
        { prefix: "/api/index.php/multi_battle_quest" },
    )
    await fastify.ready()
})

test.after(async () => { await fastify.close() })

test("create_room for a gated boss quest rejects a player without the prerequisite", async () => {
    const host = await createPlayer("no-progress")
    const response = await post(fastify, "/api/index.php/multi_battle_quest/create_room", {
        viewer_id: host.viewerId, category: 2, quest_id: 1001002, party_id: 1, api_count: 1,
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error, "QUEST_NOT_AVAILABLE")
})

test("create_room for a gated boss quest succeeds once the main-quest prerequisite is finished", async () => {
    const host = await createPlayer("with-progress")
    setProgress(host.playerId, 1, 6010004)
    const response = await post(fastify, "/api/index.php/multi_battle_quest/create_room", {
        viewer_id: host.viewerId, category: 2, quest_id: 1001002, party_id: 1, api_count: 1,
    })
    assert.equal(response.statusCode, 200, response.body)
    return decode(response).data.room_number
})

test("select_room join is rejected while the previous tier is uncleared, and allowed after (R-G04 skip hole)", async () => {
    const host = await createPlayer("host-chained")
    setProgress(host.playerId, 1, 6010004)
    setProgress(host.playerId, 2, 1001002)
    const created = await post(fastify, "/api/index.php/multi_battle_quest/create_room", {
        viewer_id: host.viewerId, category: 2, quest_id: 1001003, party_id: 1, api_count: 1,
    })
    assert.equal(created.statusCode, 200, created.body)
    const roomNumber = decode(created).data.room_number

    const guest = await createPlayer("guest-skipping")
    // 未通关 1001002：按房间号加入 1001003 必须软拒（unavailable 投影，非踢出）
    const rejected = await post(fastify, "/api/index.php/multi_battle_quest/select_room", {
        viewer_id: guest.viewerId, room_number: roomNumber,
        category: 2, quest_id: 1001003, api_count: 1,
    })
    assert.equal(rejected.statusCode, 200, rejected.body)
    const rejectedData = decode(rejected).data
    // select 的不可用投影：raising_state=7（NotPlayable，客户端软提示）、
    // quest_id/ip 归零、不返回连接地址
    assert.equal(rejectedData.raising_state, 7, "未满足前置链的加入必须投影为 NotPlayable")
    assert.equal(rejectedData.quest_id, 0)
    assert.equal(rejectedData.ip_address, "")
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS n FROM players_quest_progress WHERE player_id = ? AND quest_id = 1001003"
    ).get(guest.playerId).n, 0, "被拒加入不得留下进度/准入痕迹")

    // 通关前一档后：同一房间正常加入
    setProgress(guest.playerId, 2, 1001002)
    const allowed = await post(fastify, "/api/index.php/multi_battle_quest/select_room", {
        viewer_id: guest.viewerId, room_number: roomNumber,
        category: 2, quest_id: 1001003, api_count: 2,
    })
    assert.equal(allowed.statusCode, 200, allowed.body)
    const allowedData = decode(allowed).data
    assert.equal(allowedData.quest_id, 1001003, "满足前置链后加入必须返回真实房间连接信息")
    assert.notEqual(allowedData.ip_address, "")
})

test("ungated boss quests stay open to players without any progress", async () => {
    const host = await createPlayer("ungated-host")
    const response = await post(fastify, "/api/index.php/multi_battle_quest/create_room", {
        viewer_id: host.viewerId, category: 2, quest_id: 1001001, party_id: 1, api_count: 1,
    })
    assert.equal(response.statusCode, 200, response.body)
})

test("non-boss categories are never gated", () => {
    assert.equal(isBossQuestJoinAllowed(1, 6010004, () => null), true,
        "主线任务不受 boss 参加门约束")
    assert.equal(isBossQuestJoinAllowed(2, 1001002, () => ({ finished: false })), false)
    assert.equal(isBossQuestJoinAllowed(2, 1001002, () => ({ finished: true })), true)
    assert.equal(isBossQuestJoinAllowed(2, 1001001, () => null), true, "无门 boss 恒放行")
})
