require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-auto-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledCharacterSnapshot } = require("./helpers/install-bundled-character-snapshot.cjs")
restoreContentSnapshot = installBundledCharacterSnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const missionRoutes = require("../src/routes/api/mission").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-auto-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000198
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
db.prepare(`
    INSERT INTO players_mails
        (player_id, reason_id, subject, description, type, type_id, number, receive_time, create_time)
    VALUES (?, 0, 'test', '', 1, 1, 1, '0000-00-00 00:00:00', ?)
`).run(playerId, new Date().toISOString())

updatePlayerSync({
    id: playerId,
    stamina: 100,
    totalStaminaUsed: 40,
    totalDashes: 10,
})
for (let index = 0; index < 2; index++) {
    recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true, clearRank: 5 })
}
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    isHost: true,
    accomplished: true,
    clearRank: 5,
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    const fastify = Fastify()
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.register(missionRoutes, { prefix: "/api/index.php/mission" })
    await fastify.ready()

    try {
        const start = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                quest_id: 2001,
                category: 22,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "mission-auto-settlement",
            }),
        })
        assert.equal(start.statusCode, 200, start.body)
        const startData = decodeResponse(start).data
        assert.deepEqual(
            startData.mission_info
                .filter(entry => entry.mission_category_id === 2)
                .map(entry => entry.mission_id),
            [13, 14, 16],
        )
        assert.equal(startData.mail_arrived, true)

        const finish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                quest_id: 2001,
                category: 22,
                score: 0,
                elapsed_time_ms: 1000,
                add_mana: 0,
                is_accomplished: true,
                statistics: {
                    clear_phase: 1,
                    max_combo_count: 0,
                    zones: [],
                    party: {
                        characters: [null, null, null],
                        unison_characters: [null, null, null],
                        equipments: [null, null, null],
                        ability_soul_ids: [null, null, null],
                    },
                },
            }),
        })
        assert.equal(finish.statusCode, 200, finish.body)
        const finishData = decodeResponse(finish).data
        assert.deepEqual(
            finishData.mission_info
                .filter(entry => entry.mission_category_id === 2)
                .map(entry => entry.mission_id),
            [11, 17],
        )
        assert.equal(finishData.mail_arrived, true)

        db.prepare(`
            DELETE FROM players_category_mission_stages
            WHERE player_id = ? AND category = 2 AND mission_id = 17
        `).run(playerId)
        db.prepare(`
            DELETE FROM players_category_missions
            WHERE player_id = ? AND category = 2 AND id = 17
        `).run(playerId)
        const dailyPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 2 }],
            }),
        })
        assert.equal(dailyPage.statusCode, 200, dailyPage.body)
        const dailyPageData = decodeResponse(dailyPage).data
        assert.deepEqual(dailyPageData.mission_info.map(entry => entry.mission_id), [17])
        assert.equal(
            dailyPageData.mission_progress_list.find(entry => entry.mission_id === 17).progress_value,
            4,
            "同一任务页响应的 all-clear 进度必须与已发放奖励一致",
        )

        updatePlayerSync({ id: playerId, totalLoginDays: 3 })
        const weekly = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 10 }],
            }),
        })
        assert.equal(weekly.statusCode, 200, weekly.body)
        const weeklyData = decodeResponse(weekly).data
        assert.deepEqual(
            weeklyData.mission_info.map(entry => entry.mission_id),
            [1],
        )
        assert.equal(weeklyData.mail_arrived, true)

        setServerTimeOffset(Date.parse("2020-02-21T03:00:00.000Z") - Date.now())
        givePlayerItemSync(playerId, 80001, 50)
        const collectPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 4, event_id: 1 }],
            }),
        })
        assert.equal(collectPage.statusCode, 200, collectPage.body)
        const collectPageData = decodeResponse(collectPage).data
        assert.deepEqual(collectPageData.mission_info, [{
            mission_category_id: 4,
            mission_id: 1500,
            mission_reward_id: 1500001,
        }])
        assert.equal(
            collectPageData.mission_progress_list.find(entry => entry.mission_id === 1500).progress_value,
            50,
        )
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("mission auto settlement route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
