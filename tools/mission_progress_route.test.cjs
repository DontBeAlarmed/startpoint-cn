require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pack, unpack } = require("msgpackr")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const observedAutomaticScopes = []

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-progress-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreTimeOffset = () => {}

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    restoreTimeOffset()
}

process.once("exit", cleanupDatabase)

stubModule("../src/lib/mission/index", {
    getComputer: () => ({
        buildContext: () => ({}),
        compute: (_missionId, _ctx, dbProgress) => dbProgress,
    }),
    getMissionIdsByCategory: category => category === 5
        ? [47000, 48000, 49000, 50000]
        : [],
    getCurrentStage: () => 0,
    getCharacterIdFromMission: () => "",
    isMissionEnabledAt: () => true,
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
    settleAwakeMissionRewards: () => ({
        missionInfo: [], itemList: {}, characterList: [], equipmentList: [], degreeIds: [],
    }),
    settleMissionCategories: (_playerId, scopes) => {
        observedAutomaticScopes.push(structuredClone(scopes))
        return {
            missionInfo: scopes.flatMap(scope => scope.missionIds.map(missionId => ({
                mission_category_id: scope.category,
                mission_id: missionId,
                mission_reward_id: missionId * 1000 + 1,
            }))),
            itemList: {},
            characterList: [],
            equipmentList: [],
            degreeIds: [],
            passCardPoints: {},
        }
    },
    settleMissionCategoriesWithEvaluation: playerId => {
        const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
        const missions = Object.entries(getPlayerCategoryMissionsSync(playerId, 5)).map(([missionId, mission]) => ({
            category: 5,
            missionId: Number(missionId),
            declaredFactDependencies: [],
            dbProgress: mission.progress,
            computedProgress: mission.progress,
            finalProgress: mission.progress,
            receivedStages: [],
        }))
        return {
            prepared: {
                scopes: [{
                    category: 5,
                    candidateCount: missions.length,
                    enabledMissionIds: missions.map(mission => mission.missionId),
                }],
                candidates: [],
                passPreparation: {},
            },
            evaluation: { playerId, missions },
            settlement: { missionInfo: [], itemList: {}, characterList: [], equipmentList: [], degreeIds: [] },
            invalidatedFactKeys: [],
        }
    },
    evaluateMissionProgressStageB: () => null,
    mergeMissionSettlementResponse: (data, settlement) => {
        data.mission_info.push(...settlement.missionInfo)
    },
})

const missionRoutes = require("../src/routes/api/mission").default
const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
function setServerTime(isoTimestamp) {
    setServerTimeOffset(Date.parse(isoTimestamp) - Date.now())
}

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-progress-route-test-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000017
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

async function postProgress(fastify, missionPattern, progressValue) {
    return fastify.inject({
        method: "POST",
        url: "/update_mission_progress",
        payload: {
            viewer_id: viewerId,
            api_count: 1,
            mission_param_list: [{
                mission_pattern: missionPattern,
                progress_value: progressValue,
            }],
        },
    })
}

async function postPayload(fastify, payload) {
    return fastify.inject({
        method: "POST",
        url: "/update_mission_progress",
        payload,
    })
}

async function main() {
    setServerTime("2024-08-14T12:00:00.000Z")
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    await fastify.register(missionRoutes)
    await fastify.ready()

    try {
        await postProgress(fastify, "unknown_pattern", 1)
        await postProgress(fastify, "twitter_check", -1)
        await postProgress(fastify, "collect_item_event_001_01", 1)
        await postProgress(fastify, "twitter_check", 1)
        assert.deepEqual(
            getPlayerCategoryMissionsSync(playerId, 1),
            {},
            "未知、非法、非白名单和未开放任务不得写库",
        )

        setServerTime("2099-12-30T04:00:00.000Z")
        await postProgress(fastify, "twitter_check", 1)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[107].progress, 1)

        await postProgress(fastify, "twitter_check", Number.NaN)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[107].progress, 1)

        setServerTime("2024-08-14T12:00:00.000Z")
        const degreeCases = [
            ["character_detail_zoom_illust_for_1min_count", 47000],
            ["character_detail_play_dot_sp_motion_count", 48000],
            ["home_tap_town_character_count", 49000],
            ["home_change_voice_count", 50000],
        ]
        for (const [missionPattern, missionId] of degreeCases) {
            const response = await postProgress(fastify, missionPattern, 1)
            assert.equal(response.statusCode, 200, response.body)
            assert.deepEqual(unpack(response.rawPayload).data.mission_info, [{
                mission_category_id: 5,
                mission_id: missionId,
                mission_reward_id: missionId * 1000 + 1,
            }])
            assert.deepEqual(observedAutomaticScopes.at(-1), [{
                category: 5,
                missionIds: [missionId],
            }])
            const progress = getPlayerCategoryMissionsSync(playerId, 5)
            assert.equal(progress[missionId]?.progress, 1, `${missionPattern} 必须只累计对应 Degree`)
        }

        await postProgress(fastify, "character_detail_zoom_illust_for_1min_count", 2)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 5)[47000].progress, 3)

        for (const wrongAction of [
            "home_voice_change_count",
            "degree_sukimono_1",
            "twitter_check",
        ]) {
            await postProgress(fastify, wrongAction, 7)
        }
        assert.deepEqual(
            Object.fromEntries(Object.entries(getPlayerCategoryMissionsSync(playerId, 5))
                .map(([missionId, mission]) => [missionId, mission.progress])),
            { 47000: 3, 48000: 1, 49000: 1, 50000: 1 },
            "错误动作或近似字段不得污染四条 Degree 进度",
        )

        for (const missionParamList of [
            { mission_pattern: "home_change_voice_count", progress_value: 99 },
            [null, 1, {}, { mission_pattern: 42, progress_value: 99 }],
        ]) {
            const response = await postPayload(fastify, {
                viewer_id: viewerId,
                api_count: 1,
                mission_param_list: missionParamList,
            })
            assert.equal(response.statusCode, 200)
        }
        assert.equal(getPlayerCategoryMissionsSync(playerId, 5)[50000].progress, 1)

        await postProgress(fastify, "home_change_voice_count", Number.MAX_SAFE_INTEGER)
        assert.equal(
            getPlayerCategoryMissionsSync(playerId, 5)[50000].progress,
            1,
            "溢出增量必须 fail closed，不能让进度倒退或失去安全整数精度",
        )

        const orphanAccount = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "test",
            idpId: `mission-progress-route-orphan-${randomUUID()}`,
            status: "normal",
        })
        const orphanViewerId = viewerId + 1
        db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
            .run(String(orphanViewerId), orphanAccount.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
        const orphanResponse = await postPayload(fastify, {
            viewer_id: orphanViewerId,
            api_count: 1,
            mission_param_list: [{
                mission_pattern: "home_change_voice_count",
                progress_value: 99,
            }],
        })
        assert.equal(orphanResponse.statusCode, 500)

        closeDatabase()
        initializeDatabase()
        db = getDb()
        assert.deepEqual(
            Object.fromEntries(Object.entries(getPlayerCategoryMissionsSync(playerId, 5))
                .map(([missionId, mission]) => [missionId, mission.progress])),
            { 47000: 3, 48000: 1, 49000: 1, 50000: 1 },
            "服务重启后必须保留客户端进度事实",
        )
        const loadResponse = await fastify.inject({
            method: "POST",
            url: "/get_mission_progress",
            payload: {
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 5 }],
            },
        })
        assert.equal(loadResponse.statusCode, 200, loadResponse.body)
        assert.deepEqual(
            Object.fromEntries(unpack(loadResponse.rawPayload).data.mission_progress_list
                .map(mission => [mission.mission_id, mission.progress_value])),
            { 47000: 3, 48000: 1, 49000: 1, 50000: 1 },
            "重启后的任务 load 必须返回持久化事实",
        )
    } finally {
        await fastify.close()
        cleanupDatabase()
        process.removeListener("exit", cleanupDatabase)
    }
}

main().then(
    () => console.log("mission progress route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
