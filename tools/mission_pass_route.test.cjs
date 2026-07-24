require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pass-route-db-"))
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
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
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
    idpId: `mission-pass-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000218
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

updatePlayerSync({ id: playerId, totalDashes: 10, totalStaminaUsed: 40 })
recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true, clearRank: 5 })
recordMissionBattleResultSync(playerId, { isMulti: true, isHost: true, accomplished: true, clearRank: 5 })

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
    await fastify.register(missionRoutes, { prefix: "/api/index.php/mission" })
    await fastify.ready()

    try {
        const request = () => fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 6 }, { category: 7 }, { category: 8 }],
            }),
        })

        const firstResponse = await request()
        assert.equal(firstResponse.statusCode, 200, firstResponse.body)
        const first = decodeResponse(firstResponse).data
        assert.deepEqual(
            first.mission_progress_list.reduce((counts, mission) => {
                counts[mission.mission_category] = (counts[mission.mission_category] ?? 0) + 1
                return counts
            }, {}),
            { 6: 4, 7: 4, 8: 3 },
        )
        assert.deepEqual(
            first.mission_info.map(entry => [entry.mission_category_id, entry.mission_id]),
            [[6, 9], [6, 10], [6, 11], [8, 13]],
        )
        assert.deepEqual(
            Object.fromEntries(first.mission_progress_list
                .filter(entry => entry.mission_category === 7)
                .map(entry => [entry.mission_id, entry.progress_value])),
            { 9: 40, 10: 1, 11: 0, 12: 0 },
            "Pass 开放期间新建存档后的周常事实必须从建档基线开始累计",
        )
        assert.equal(db.prepare(`
            SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
        `).get(playerId).point, 250)

        const repeatedResponse = await request()
        assert.equal(repeatedResponse.statusCode, 200, repeatedResponse.body)
        assert.deepEqual(decodeResponse(repeatedResponse).data.mission_info, [])
        assert.equal(db.prepare(`
            SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
        `).get(playerId).point, 250)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("mission pass route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
