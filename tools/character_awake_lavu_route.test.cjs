require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const LAVU_ID = 263002
const BARETTA_ID = 151006
const MISSION_ID = 2630023
const CATEGORY = 18
const QUEST_ID = 400001104

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lavu-awake-route-db-"))
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

const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const characterAssets = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const { insertActiveQuest } = require("../src/lib/quest/active-quest-service")
const missionRoutes = require("../src/routes/api/mission").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2025-01-01T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `lavu-awake-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000201
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

for (const characterId of [LAVU_ID, BARETTA_ID]) {
    insertDefaultPlayerCharacterSync(playerId, characterId)
}
const lavuRarity = characterAssets.getCharacterDataSync(LAVU_ID).rarity
updatePlayerCharacterSync(playerId, LAVU_ID, { exp: characterExpCaps[lavuRarity][0] })
insertPlayerCharacterManaNodesSync(
    playerId,
    LAVU_ID,
    Object.keys(characterAssets.getCharacterManaNodesSync(LAVU_ID, 1)).map(Number),
)

insertActiveQuest(playerId, {
    questId: QUEST_ID,
    category: CATEGORY,
    useBossBoostPoint: false,
    useBoostPoint: false,
    isAutoStartMode: false,
    isMulti: false,
    playId: "lavu-awake-super-plus",
    continueCount: 0,
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
        (_request, body, done) => {
            done(null, unpack(Buffer.from(body, "base64")))
        },
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(missionRoutes, { prefix: "/api/index.php/mission" })
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.ready()

    try {
        const finish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                play_id: "lavu-awake-super-plus",
                quest_id: QUEST_ID,
                category: CATEGORY,
                score: 0,
                elapsed_time_ms: 1000,
                add_mana: 0,
                is_accomplished: true,
                is_restored: false,
                continue_count: 0,
                statistics: {
                    clear_phase: 1,
                    max_combo_count: 0,
                    zones: [{
                        damage_deal_total: 0,
                        members: [{ origin_damage: 0 }, null, null],
                    }],
                    party: {
                        characters: [{ id: BARETTA_ID }, null, null],
                        unison_characters: [null, null, null],
                        equipments: [null, null, null],
                        ability_soul_ids: [null, null, null],
                    },
                },
            }),
        })
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[MISSION_ID].progress, 1)

        const progress = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 9, character_id: LAVU_ID }],
            }),
        })
        assert.equal(progress.statusCode, 200, progress.body)
        const progressData = decodeResponse(progress).data
        const missionProgress = progressData.mission_progress_list.find(
            entry => entry.mission_id === MISSION_ID,
        )
        assert.equal(missionProgress.mission_id, MISSION_ID)
        assert.equal(missionProgress.progress_value >= 1, true)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("lavu awake route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
