"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { registerBattleRoutes } = require("../src/multi/http/battle")
const { grantInventoryFixtureItemSync } = require("./helpers/inventory-fixture.cjs")

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-finish-idempotent-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseRoot
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: [
        "event_item_shop.json",
        "mission_active.json",
        "mission_active_event.json",
    ],
})
const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")

process.once("exit", () => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDataDirectory
})

const participant = Object.freeze({ nodeSessionId: "node-host", viewerId: 101 })
const productionQuest = Object.freeze({ category: 13, questId: 2001, ticketId: 500000 })
const roomNumber = "123456"
const battleSessionId = "123e4567-e89b-42d3-a456-426614174002"
const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

// finish-response-cache 是模块级单例（key 含 playId），每个用例用独立 playId
// 防止跨用例的缓存命中串扰。
function startPayload(viewerId, playId, overrides = {}) {
    return {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: productionQuest.questId,
        category: productionQuest.category,
        party_id: 1,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
        room_number: roomNumber,
        mate_player_ids: [],
        play_id: playId,
        ...overrides,
    }
}

function finishPayload(viewerId, playId, overrides = {}) {
    return {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: productionQuest.questId,
        category: productionQuest.category,
        room_number: roomNumber,
        play_id: playId,
        score: 0,
        elapsed_time_ms: 1_000,
        add_mana: 0,
        is_accomplished: true,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{ use_power_flip_count: 1 }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
        mate_player_result: [],
        ...overrides,
    }
}

async function openIdempotentHome(label) {
    closeDatabase()
    const homeDirectory = path.join(databaseRoot, label)
    process.env.DATA_DIR = homeDirectory
    initializeDatabase()
    const db = getDb()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({
        id: playerId,
        stamina: 100,
        staminaHealTime: new Date(Math.floor(Date.now() / 1_000) * 1_000),
        totalStaminaUsed: 0,
    })
    grantInventoryFixtureItemSync(playerId, productionQuest.ticketId, 1)
    // R-G04 参加门：challenge_dungeon 2001 的 viewable 前置是主线 1008004 通关
    insertPlayerQuestProgressSync(playerId, 1, {
        questId: 1008004,
        finished: true,
        unlocked: true,
    })

    const battle = Object.freeze({
        battleSessionId,
        roomNumber,
        host: participant,
        participants: [participant],
        finalized: false,
    })
    const coordinator = {
        getRoomStatus: async () => ({ ok: true, value: {
            roomNumber,
            host: participant,
            members: [participant],
            category: productionQuest.category,
            questId: productionQuest.questId,
        } }),
        startBattle: async () => ({ ok: true, value: battle }),
        finalizeBattle: async () => ({ ok: true, value: { ...battle, finalized: true } }),
        abortBattle: async () => ({ ok: true, value: undefined }),
    }
    const context = {
        resolvePlayerContext: async viewerId => viewerId === participant.viewerId
            ? { playerId, player: getPlayerSync(playerId) }
            : null,
        snapshotProvider: {
            getParticipant: viewerId => ({ ...participant, viewerId }),
            getCompatibility: () => ({ ok: true, value: compatibility }),
        },
        questAvailability: { check: () => ({ available: true }) },
        coordinator,
        resolveCoordinatorOrigin: async () => "remote",
        settlementVerifier: { verify: async () => ({ ok: true, isHost: true }) },
    }
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")
            && payload !== null
            && typeof payload === "object") {
            done(null, JSON.stringify(payload))
            return
        }
        done(null, payload)
    })
    registerBattleRoutes(app, context)
    await app.ready()
    return { app, db, playerId }
}

async function closeIdempotentHome(home) {
    if (home) await home.app.close()
    closeDatabase()
}

function questClearRowCount(home) {
    return home.db.prepare(`
        SELECT COUNT(*) AS count FROM players_quest_progress
        WHERE player_id = ? AND quest_id = ? AND finished = 1
    `).get(home.playerId, productionQuest.questId).count
}

test("duplicate finish inside the cache TTL replays the original response and settles once", async () => {
    let home
    try {
        home = await openIdempotentHome("finish-replay")
        const playId = "finish-replay-play"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(participant.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        const first = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(participant.viewerId, playId),
        })
        assert.equal(first.statusCode, 200, first.body)
        const firstBody = JSON.parse(first.body)

        const second = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(participant.viewerId, playId),
        })
        assert.equal(second.statusCode, 200, second.body)
        const secondBody = JSON.parse(second.body)
        assert.deepEqual(secondBody, firstBody, "TTL 内重复 finish 必须逐字节回放首次响应")

        const third = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(participant.viewerId, playId),
        })
        assert.equal(third.statusCode, 200, third.body)
        assert.deepEqual(JSON.parse(third.body), firstBody)

        assert.equal(
            questClearRowCount(home),
            1,
            "重复 finish 不得把同一关卡结算两次",
        )
    } finally {
        await closeIdempotentHome(home)
    }
})

test("concurrent duplicate finishes settle exactly once", async () => {
    let home
    try {
        home = await openIdempotentHome("finish-concurrent")
        const playId = "finish-concurrent-play"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(participant.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        const [a, b] = await Promise.all([
            home.app.inject({ method: "POST", url: "/finish", payload: finishPayload(participant.viewerId, playId) }),
            home.app.inject({ method: "POST", url: "/finish", payload: finishPayload(participant.viewerId, playId) }),
        ])
        for (const response of [a, b]) {
            assert.ok(response.statusCode === 200 || response.statusCode === 400,
                `并发重复 finish 只允许 200（回放）或 400（冲突），实际 ${response.statusCode}`)
        }
        assert.equal(a.statusCode, 200, a.body)
        if (b.statusCode === 200) {
            assert.deepEqual(
                JSON.parse(b.body),
                JSON.parse(a.body),
                "并发落败方若走缓存回放，必须与胜者响应完全一致",
            )
        }
        assert.equal(
            questClearRowCount(home),
            1,
            "并发重复 finish 必须只结算一次",
        )
    } finally {
        await closeIdempotentHome(home)
    }
})

test("abort without category/quest_id resolves them from the stored quest and succeeds", async () => {
    let home
    try {
        home = await openIdempotentHome("abort-lenient")
        const playId = "abort-lenient-play"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(participant.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        // CN 客户端的 abort 可能缺 category/quest_id：必须以 storedQuest 补全后成功
        const aborted = await home.app.inject({
            method: "POST",
            url: "/abort",
            payload: {
                viewer_id: participant.viewerId,
                room_number: roomNumber,
                play_id: playId,
                api_count: 1,
            },
        })
        assert.equal(aborted.statusCode, 200, aborted.body)
        const abortedBody = JSON.parse(aborted.body)
        assert.equal(abortedBody.data.is_multi, "multi")
        assert.equal(
            getPlayerActiveQuestSync(home.playerId),
            null,
            "缺字段的宽容 abort 必须真正取消活跃任务",
        )
    } finally {
        await closeIdempotentHome(home)
    }
})

test("abort with a mismatched play_id is a 200 no-op that keeps the battle", async () => {
    let home
    try {
        home = await openIdempotentHome("abort-stale")
        const playId = "abort-stale-play"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(participant.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        const aborted = await home.app.inject({
            method: "POST",
            url: "/abort",
            payload: {
                viewer_id: participant.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: "stale-other-play",
                api_count: 1,
            },
        })
        assert.equal(aborted.statusCode, 200, aborted.body)
        assert.deepEqual(
            JSON.parse(aborted.body).data,
            {},
            "play_id 不匹配的迟到 abort 是幂等空终态",
        )
        const storedQuest = getPlayerActiveQuestSync(home.playerId)
        assert.ok(storedQuest && storedQuest.playId === playId, "迟到 abort 不得动当前局")
    } finally {
        await closeIdempotentHome(home)
    }
})

test("play_continue without an active quest returns a 200 terminal count", async () => {
    let home
    try {
        home = await openIdempotentHome("continue-no-quest")
        const continued = await home.app.inject({
            method: "POST",
            url: "/play_continue",
            payload: {
                viewer_id: participant.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: "continue-no-quest-play",
                api_count: 1,
            },
        })
        assert.equal(continued.statusCode, 200, continued.body)
        assert.deepEqual(
            JSON.parse(continued.body).data,
            { continue_count: 0 },
            "无活跃任务的迟到 continue 是 200 幂等终态，不渲染 H400",
        )
    } finally {
        await closeIdempotentHome(home)
    }
})

test("play_continue with a mismatched play_id returns the current count without writing", async () => {
    let home
    try {
        home = await openIdempotentHome("continue-stale")
        const playId = "continue-stale-play"
        const started = await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(participant.viewerId, playId),
        })
        assert.equal(started.statusCode, 200, started.body)

        const stale = await home.app.inject({
            method: "POST",
            url: "/play_continue",
            payload: {
                viewer_id: participant.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: "stale-other-play",
                api_count: 1,
            },
        })
        assert.equal(stale.statusCode, 200, stale.body)
        assert.deepEqual(
            JSON.parse(stale.body).data,
            { continue_count: 0 },
            "play_id 不匹配的 continue 返回当前计数且不写入",
        )

        const matched = await home.app.inject({
            method: "POST",
            url: "/play_continue",
            payload: {
                viewer_id: participant.viewerId,
                quest_id: productionQuest.questId,
                category: productionQuest.category,
                room_number: roomNumber,
                play_id: playId,
                api_count: 1,
            },
        })
        assert.equal(matched.statusCode, 200, matched.body)
        assert.deepEqual(
            JSON.parse(matched.body).data,
            { continue_count: 1 },
            "身份匹配的 continue 正常推进计数",
        )
    } finally {
        await closeIdempotentHome(home)
    }
})
