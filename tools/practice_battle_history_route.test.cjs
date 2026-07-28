require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "practice-history-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    insertPlayerPracticeBattleHistorySync,
} = require("../src/data/domains/practice-battle-history")

async function main() {
    db = initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `practice-history-route-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 800123456
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    insertPlayerPracticeBattleHistorySync({
        playerId,
        playId: "route-practice-1",
        ability_soul_id_1: null,
        ability_soul_id_2: null,
        ability_soul_id_3: null,
        category_id: 15,
        character_1_total_damage: 100,
        character_2_total_damage: null,
        character_3_total_damage: null,
        character_id_1: 101,
        character_id_2: null,
        character_id_3: null,
        clear_rank: 5,
        create_time: "2024-08-14 12:00:00",
        elapsed_time_ms: 90_000,
        enhancement_level_1: null,
        enhancement_level_2: null,
        enhancement_level_3: null,
        equipment1_id: null,
        equipment2_id: null,
        equipment3_id: null,
        equipment_level_1: null,
        equipment_level_2: null,
        equipment_level_3: null,
        finish_kind: 0,
        quest_id: 1,
        score: 12_345,
        total_damage: 100,
        unison_character_id_1: null,
        unison_character_id_2: null,
        unison_character_id_3: null,
    })

    const routes = require("../src/routes/api/history").default
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    fastify.register(routes)

    const response = await fastify.inject({
        method: "POST",
        url: "/practice_battle",
        payload: { viewer_id: viewerId },
    })
    assert.equal(response.statusCode, 200, response.body)
    const decoded = unpack(Buffer.from(response.body, "base64"))
    assert.equal(decoded.data.history.length, 1)
    assert.equal(decoded.data.history[0].score, 12_345)
    assert.equal(Object.keys(decoded.data.history[0]).length, 29)

    const invalidViewer = await fastify.inject({
        method: "POST",
        url: "/practice_battle",
        payload: { viewer_id: 999999999 },
    })
    assert.equal(invalidViewer.statusCode, 400)

    await fastify.close()
    cleanup()
    process.removeListener("exit", cleanup)
}

main().then(
    () => console.log("practice battle history route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
