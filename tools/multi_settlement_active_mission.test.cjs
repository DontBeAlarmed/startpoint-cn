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

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-active-mission-db-"))
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
const {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} = require("../src/data/domains/mission")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")

process.once("exit", () => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseRoot, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

const host = Object.freeze({ nodeSessionId: "node-host", viewerId: 101 })
const guest = Object.freeze({ nodeSessionId: "node-guest", viewerId: 202 })
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

async function openActiveMissionHome(label, participant, isHost) {
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

    const roomHost = isHost ? participant : host
    const roomMembers = [roomHost, participant].filter((member, index, all) => (
        all.findIndex(candidate => candidate.nodeSessionId === member.nodeSessionId
            && candidate.viewerId === member.viewerId) === index
    ))
    const battle = Object.freeze({
        battleSessionId,
        roomNumber,
        host: roomHost,
        participants: roomMembers,
        finalized: false,
    })
    const coordinator = {
        getRoomStatus: async () => ({ ok: true, value: {
            roomNumber,
            host: roomHost,
            members: roomMembers,
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
        settlementVerifier: { verify: async () => ({ ok: true, isHost }) },
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

async function closeActiveMissionHome(home) {
    if (home) await home.app.close()
    closeDatabase()
}

// Mission 20010 (event 1, pattern 23 with an empty quest selector) counts
// finished quests, so a successful multi finish of quest 2001 must publish
// its Active Mission progress in the same transaction and response. Its need
// gate is the Contents Guide start mission 20001, seeded before each battle.
const ANY_CLEAR_MISSION_ID = 20010

function seedContentsGuideStart(home) {
    insertPlayerQuestProgressSync(home.playerId, 1, {
        questId: 1008004,
        finished: true,
        unlocked: true,
    })
    updatePlayerActiveMissionSync(home.playerId, 20001, 1)
    updatePlayerActiveMissionStageSync(home.playerId, 1, 20001, true)
}

for (const [label, participant, isHost] of [
    ["host", host, true],
    ["guest", guest, false],
]) {
    test(`multi ${label} /finish publishes Active Mission progress in the same response`, async () => {
        let home
        try {
            home = await openActiveMissionHome(`active-mission-${label}`, participant, isHost)
            seedContentsGuideStart(home)
            const playId = `active-mission-${label}`
            const started = await home.app.inject({
                method: "POST",
                url: "/start",
                payload: startPayload(participant.viewerId, playId),
            })
            assert.equal(started.statusCode, 200, started.body)

            const finished = await home.app.inject({
                method: "POST",
                url: "/finish",
                payload: finishPayload(participant.viewerId, playId),
            })
            assert.equal(finished.statusCode, 200, finished.body)
            const data = JSON.parse(finished.body).data
            const anyClearDelta = (data.active_mission_list ?? []).find(delta => (
                delta.mission_id === ANY_CLEAR_MISSION_ID
            ))
            assert.ok(
                anyClearDelta && anyClearDelta.progress_value >= 1,
                `多人成功结算必须在响应携带 active_mission_list，含 ${ANY_CLEAR_MISSION_ID} 的进度`,
            )
            assert.ok(
                (getPlayerActiveMissionsSync(home.playerId)[ANY_CLEAR_MISSION_ID]?.progress ?? 0) >= 1,
                "多人成功结算必须同步写入数据库进度",
            )
        } finally {
            await closeActiveMissionHome(home)
        }
    })
}

test("failed multi /finish does not manufacture Active Mission clear progress", async () => {
    let home
    try {
        home = await openActiveMissionHome("active-mission-failed", host, true)
        seedContentsGuideStart(home)
        const playId = "active-mission-failed"
        await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId),
        })
        const failed = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId, { is_accomplished: false }),
        })
        assert.equal(failed.statusCode, 200, failed.body)
        const data = JSON.parse(failed.body).data
        const anyClearDelta = (data.active_mission_list ?? []).find(delta => (
            delta.mission_id === ANY_CLEAR_MISSION_ID
        ))
        // Pattern 23 counts every finished quest, so the seeded prerequisite
        // quest legitimately yields progress 1. The failed battle must not
        // add its own quest on top of the pre-existing facts.
        assert.equal(
            anyClearDelta ? anyClearDelta.progress_value : (
                getPlayerActiveMissionsSync(home.playerId)[ANY_CLEAR_MISSION_ID]?.progress ?? 0
            ),
            1,
            "失败战斗不得在既有事实上额外累计通关进度",
        )
        assert.equal(
            home.db.prepare(`
                SELECT COUNT(*) AS count FROM players_quest_progress
                WHERE player_id = ? AND quest_id = ?
            `).get(home.playerId, productionQuest.questId).count,
            0,
            "失败战斗不得把本场关卡记为通关",
        )
    } finally {
        await closeActiveMissionHome(home)
    }
})

test("Active Mission fixed-point failure rolls the whole multi /finish back", async () => {
    let home
    try {
        home = await openActiveMissionHome("active-mission-rollback", host, true)
        seedContentsGuideStart(home)
        home.db.exec(`
            CREATE TRIGGER reject_active_progress_insert
            BEFORE INSERT ON players_active_missions
            WHEN NEW.player_id = ${home.playerId}
            BEGIN SELECT RAISE(ABORT, 'forced multi fixed-point failure'); END;
        `)
        const playId = "active-mission-rollback"
        await home.app.inject({
            method: "POST",
            url: "/start",
            payload: startPayload(host.viewerId, playId),
        })
        const failed = await home.app.inject({
            method: "POST",
            url: "/finish",
            payload: finishPayload(host.viewerId, playId),
        })
        assert.equal(failed.statusCode, 500, failed.body)
        home.db.exec("DROP TRIGGER reject_active_progress_insert")
        assert.equal(
            home.db.prepare(`
                SELECT COUNT(*) AS count FROM players_quest_progress
                WHERE player_id = ? AND quest_id = ?
            `).get(home.playerId, productionQuest.questId).count,
            0,
            "固定点写失败必须连带回滚多人结算的全部业务写入",
        )
        assert.equal(getPlayerActiveMissionsSync(home.playerId)[ANY_CLEAR_MISSION_ID]?.progress ?? 0, 0)
    } finally {
        await closeActiveMissionHome(home)
    }
})
