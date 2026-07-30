require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-page-tx-db-"))
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

stubModule("../src/lib/mission/computer-awake", {
    buildAwakeContext: () => ({}),
})
stubModule("../src/lib/mission/index", {
    createCharacterAwakeEligibilityResolver: () => ({
        characters: [],
        isNewUnlockEligible: () => true,
    }),
    getComputer: () => ({
        buildContext: () => ({}),
        compute: () => 1,
    }),
    getMissionIdsByCategory: category => category === 9 ? [3410051] : [],
    getCurrentStage: () => 1,
    getCharacterIdFromMission: () => "341005",
    isMissionEnabledAt: () => true,
    mergeMissionSettlementResponse: () => {},
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
    settleMissionCategories: playerId => getDb().transaction(() => {
        getDb().prepare(`
            INSERT INTO players_items (id, amount, player_id)
            VALUES (900001, 1, ?)
        `).run(playerId)
        return {
            missionInfo: [], itemList: {}, characterList: [], equipmentList: [],
            degreeIds: [], passCardPoints: {},
        }
    })(),
    settleAwakeMissionRewards: playerId => getDb().transaction(() => {
        getDb().prepare(`
            INSERT INTO players_items (id, amount, player_id)
            VALUES (900002, 1, ?)
        `).run(playerId)
        throw new Error("injected second settlement failure")
    })(),
})

const missionRoutes = require("../src/routes/api/mission").default
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-page-tx-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000299
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

async function main() {
    const fastify = Fastify()
    await fastify.register(missionRoutes)
    await fastify.ready()

    try {
        const response = await fastify.inject({
            method: "POST",
            url: "/get_mission_progress",
            payload: {
                viewer_id: viewerId,
                api_count: 1,
                category_list: [
                    { category: 1 },
                    { category: 9, character_id: 341005 },
                ],
            },
        })
        assert.equal(response.statusCode, 500)
        assert.deepEqual(
            db.prepare(`
                SELECT id, amount
                FROM players_items
                WHERE player_id = ? AND id IN (900001, 900002)
                ORDER BY id
            `).all(playerId),
            [],
            "任务页后半段失败时，先前已结算的普通任务奖励也必须回滚",
        )
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("mission get-progress transaction tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
