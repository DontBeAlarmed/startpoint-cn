"use strict"

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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-stage-b-route-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
initializeDatabase()
db = getDb()

let stageBEvaluationCalls = 0
let standardComputerCalls = 0
const stageAEvaluation = {
    prepared: {
        playerId: 1,
        evaluationTime: "2024-08-14T12:00:00.000Z",
        scopes: [{ category: 1, candidateCount: 3, enabledMissionIds: [101, 102, 103] }],
        candidates: [
            { category: 1, missionId: 101 },
            { category: 1, missionId: 102 },
            { category: 1, missionId: 103 },
        ],
        passPreparation: { weeklyEventIds: [], loginEventIds: [] },
    },
    evaluation: {
        playerId: 1,
        evaluationTime: "2024-08-14T12:00:00.000Z",
        player: {},
        missions: [
            { category: 1, missionId: 101, declaredFactDependencies: [{ kind: "player" }], dbProgress: 0, computedProgress: 2, finalProgress: 2, receivedStages: [] },
            { category: 1, missionId: 102, declaredFactDependencies: [{ kind: "items" }], dbProgress: 0, computedProgress: 4, finalProgress: 4, receivedStages: [] },
            { category: 1, missionId: 103, declaredFactDependencies: [{ kind: "characters" }], dbProgress: 0, computedProgress: 3, finalProgress: 3, receivedStages: [] },
        ],
        observer: { candidateCount: 3, computeCount: 3, loaderCalls: [] },
    },
    settlement: {
        missionInfo: [],
        itemList: { "9001": 1 },
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    },
    invalidatedFactKeys: [{ kind: "items" }],
}

stubModule("../src/lib/mission/index", {
    createCharacterAwakeEligibilityResolver: () => ({ characters: [], isNewUnlockEligible: () => true }),
    evaluateMissionProgressStageB: stageA => {
        stageBEvaluationCalls++
        assert.equal(stageA, stageAEvaluation)
        return {
            ...stageA.evaluation,
            missions: [{ ...stageA.evaluation.missions[1], computedProgress: 7, finalProgress: 7 }],
            observer: { candidateCount: 1, computeCount: 1, loaderCalls: [] },
        }
    },
    getComputer: () => {
        standardComputerCalls++
        throw new Error("standard mission Computer must not be called by the response path")
    },
    getMissionIdsByCategory: category => category === 1 ? [101, 102, 103] : [],
    getCurrentStage: (_category, _missionId, progress) => progress >= 7 ? 2 : 1,
    getCharacterIdFromMission: () => "0",
    isMissionEnabledAt: () => true,
    mergeMissionSettlementResponse: (data, settlement) => {
        data.item_list = { ...(data.item_list ?? {}), ...settlement.itemList }
    },
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
    settleAwakeMissionRewards: () => ({
        missionInfo: [], itemList: {}, characterList: [], equipmentList: [], degreeIds: [], passCardPoints: {},
    }),
    settleMissionCategoriesWithEvaluation: () => stageAEvaluation,
})

const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-stage-b-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
stageAEvaluation.prepared.playerId = playerId
stageAEvaluation.evaluation.playerId = playerId
const viewerId = 800000401
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

async function main() {
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload))
            return
        }
        done(null, payload)
    })
    const missionRoutes = require("../src/routes/api/mission").default
    await fastify.register(missionRoutes)
    await fastify.ready()

    try {
        const response = await fastify.inject({
            method: "POST",
            url: "/get_mission_progress",
            payload: {
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 1 }],
            },
        })
        assert.equal(response.statusCode, 200, response.body)
        const data = unpack(response.rawPayload).data
        assert.deepEqual(
            data.mission_progress_list.map(entry => [entry.mission_id, entry.progress_value]),
            [[101, 2], [102, 7], [103, 3]],
        )
        assert.deepEqual(data.item_list, { "9001": 1 })
        assert.equal(stageBEvaluationCalls, 1)
        assert.equal(standardComputerCalls, 0)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("mission progress Stage B route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
