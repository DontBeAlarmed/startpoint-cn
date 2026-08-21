"use strict"

require("ts-node/register/transpile-only")

const { createHash, randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { monitorEventLoopDelay, performance } = require("node:perf_hooks")

const BetterSqlite3 = require("better-sqlite3")
const Fastify = require("fastify")

const { closeDatabase, initializeDatabase } = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { insertAccountSync } = require("../../src/data/domains/account")
const { givePlayerItemSync } = require("../../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../../src/data/domains/quest_active")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")
const { computeRealTimeStamina } = require("../../src/lib/stamina")
const { registerBattleRoutes } = require("../../src/multi/http/battle")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
const { installBundledGameplaySnapshot } = require("../helpers/install-bundled-gameplay-snapshot.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const QUEST = Object.freeze({ category: 13, questId: 2001, ticketId: 500000 })
const PARTICIPANT = Object.freeze({ nodeSessionId: "baseline-host", viewerId: 101 })
const ROOM_NUMBER = "123456"
const BATTLE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174002"
const FIXED_TIME = Date.parse("2024-08-14T12:00:00.000Z")

function createHardMultiEventQuestFixture() {
    const quests = structuredClone(require("../../assets/hard_multi_event_quest.json"))
    delete quests[String(QUEST.questId)].commonRewardCounts
    return quests
}

function startPayload(playId) {
    return {
        api_count: 1,
        category: QUEST.category,
        is_auto_start_mode: false,
        mate_player_ids: [],
        party_id: 1,
        play_id: playId,
        quest_id: QUEST.questId,
        room_number: ROOM_NUMBER,
        use_boost_point: false,
        use_boss_boost_point: false,
        viewer_id: PARTICIPANT.viewerId,
    }
}

function finishPayload(playId) {
    return {
        add_mana: 0,
        api_count: 2,
        category: QUEST.category,
        continue_count: 0,
        elapsed_time_ms: 1_000,
        is_accomplished: true,
        mate_player_result: [],
        play_id: playId,
        quest_id: QUEST.questId,
        room_number: ROOM_NUMBER,
        score: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            party: {
                ability_soul_ids: [null, null, null],
                characters: [{ id: 1 }, null, null],
                equipments: [null, null, null],
                unison_characters: [null, null, null],
            },
            zones: [{ use_power_flip_count: 1 }],
        },
        viewer_id: PARTICIPANT.viewerId,
    }
}

const DYNAMIC_TIME_FIELD_PATTERN = /(?:^|_)(?:time|timestamp|date)(?:$|_)/i

function isDynamicTimeField(key) {
    return key === "servertime" || DYNAMIC_TIME_FIELD_PATTERN.test(key)
}

function normalizeForSignature(value) {
    if (Array.isArray(value)) return value.map(normalizeForSignature)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort()
        .map(key => [
            key,
            isDynamicTimeField(key)
                ? "__dynamic_time__"
                : normalizeForSignature(value[key]),
        ]))
}

function outputSignature(value) {
    return `sha256:${createHash("sha256")
        .update(JSON.stringify(normalizeForSignature(value)))
        .digest("hex")}`
}

function createSettlementProtocolSignature({ body, contentType }) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new TypeError("settlement response body must be an object")
    }
    if (typeof contentType !== "string" || contentType.length === 0) {
        throw new TypeError("settlement response contentType must be a non-empty string")
    }
    return outputSignature({ body, contentType })
}

async function runFinishScenario() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-settlement-baseline-"))
    const originalOffset = getTimeOffset()
    const originalConsole = { error: console.error, log: console.log, warn: console.warn }
    const counter = createSqlCounter()
    const measurement = { active: false, beganTransaction: false, events: [] }
    let app
    let restoreContent = () => {}
    let primaryError = null
    let result

    try {
        console.error = console.log = console.warn = () => {}
        setServerTimeOffset(FIXED_TIME - Date.now())
        restoreContent = installBundledGameplaySnapshot({
            additionalTableNames: [
                "event_item_shop.json",
                "mission_active.json",
                "mission_active_event.json",
            ],
            tableOverrides: {
                "hard_multi_event_quest.json": createHardMultiEventQuestFixture(),
                "rare_score_reward.json": {},
            },
        })
        initializeDatabase({
            paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose: sql => {
                    if (!measurement.active) return
                    counter.observe(sql)
                    if (!measurement.beganTransaction && /^BEGIN\b/i.test(String(sql).trim())) {
                        measurement.beganTransaction = true
                        measurement.events.push("transaction")
                    }
                },
            }),
        })
        const account = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "baseline",
            idpId: randomUUID(),
            status: "normal",
        })
        const playerId = insertDefaultPlayerSync(account.id).id
        updatePlayerSync({
            id: playerId,
            stamina: 100,
            staminaHealTime: new Date(Math.floor(Date.now() / 1_000) * 1_000),
            totalStaminaUsed: 0,
        })
        givePlayerItemSync(playerId, QUEST.ticketId, 1)
        computeRealTimeStamina(getPlayerSync(playerId))

        const battle = Object.freeze({
            battleSessionId: BATTLE_SESSION_ID,
            finalized: false,
            host: PARTICIPANT,
            participants: [PARTICIPANT],
            roomNumber: ROOM_NUMBER,
        })
        const coordinator = {
            abortBattle: async () => ({ ok: true, value: undefined }),
            finalizeBattle: async () => ({ ok: true, value: { ...battle, finalized: true } }),
            getRoomStatus: async () => ({
                ok: true,
                value: {
                    category: QUEST.category,
                    host: PARTICIPANT,
                    members: [PARTICIPANT],
                    questId: QUEST.questId,
                    roomNumber: ROOM_NUMBER,
                },
            }),
            startBattle: async () => ({ ok: true, value: battle }),
        }
        const context = {
            coordinator,
            questAvailability: { check: () => ({ available: true }) },
            resolveCoordinatorOrigin: async () => "remote",
            resolvePlayerContext: async viewerId => viewerId === PARTICIPANT.viewerId
                ? { player: getPlayerSync(playerId), playerId }
                : null,
            settlementVerifier: {
                verify: async () => {
                    measurement.events.push("verify")
                    return { isHost: true, ok: true }
                },
            },
            snapshotProvider: {
                getCompatibility: () => ({
                    ok: true,
                    value: {
                        APP_VER: "1.8.1",
                        RES_VER: "1.4.54",
                        cdnTargetVersion: "1.4.54",
                        contentDigest: `sha256:${"a".repeat(64)}`,
                        modeDigest: `sha256:${"b".repeat(64)}`,
                        multiProtocolVersion: 1,
                    },
                }),
                getParticipant: () => PARTICIPANT,
            },
        }
        app = Fastify({ logger: false })
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

        const playId = "multi-settlement-baseline"
        const started = await app.inject({ method: "POST", url: "/start", payload: startPayload(playId) })
        if (started.statusCode !== 200) throw new Error(`baseline start failed: ${started.body}`)

        const histogram = monitorEventLoopDelay({ resolution: 1 })
        histogram.enable()
        await new Promise(resolve => setImmediate(resolve))
        measurement.active = true
        const startedAt = performance.now()
        const finished = await app.inject({ method: "POST", url: "/finish", payload: finishPayload(playId) })
        const latencyMs = performance.now() - startedAt
        measurement.active = false
        await new Promise(resolve => setImmediate(resolve))
        histogram.disable()

        const body = JSON.parse(finished.body)
        const verifyIndex = measurement.events.indexOf("verify")
        const transactionIndex = measurement.events.indexOf("transaction")
        result = {
            activeQuestCleared: getPlayerActiveQuestSync(playerId) === null,
            eventLoopDelayMs: Math.max(0, histogram.percentile(95) / 1_000_000),
            latencyMs,
            outputSignature: createSettlementProtocolSignature({
                body,
                contentType: String(finished.headers["content-type"] ?? ""),
            }),
            sql: counter.snapshot(),
            statusCode: finished.statusCode,
            verificationBeforeTransaction: verifyIndex >= 0
                && transactionIndex >= 0
                && verifyIndex < transactionIndex,
        }
    } catch (error) {
        primaryError = error
    }

    const cleanupErrors = []
    for (const cleanup of [
        async () => { if (app) await app.close() },
        () => { for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId] },
        () => closeDatabase(),
        () => restoreContent(),
        () => setServerTimeOffset(originalOffset),
        () => fs.rmSync(directory, { force: true, recursive: true }),
        () => Object.assign(console, originalConsole),
    ]) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError) throw primaryError
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "settlement baseline cleanup failed")
    return result
}

const SCENARIOS = Object.freeze([
    Object.freeze({ name: "finish", run: runFinishScenario }),
])

module.exports = {
    SCENARIOS,
    createHardMultiEventQuestFixture,
    createSettlementProtocolSignature,
}
