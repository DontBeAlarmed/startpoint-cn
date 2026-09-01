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
const LAVU_MISSION_ID = 2630023
const LAVU_CATEGORY = 18
const LAVU_QUEST_ID = 400001104
const RAMS_ID = 231001
const RAMS_MISSION_ID = 2310013
const RAMS_CATEGORY = 21
const RAMS_QUEST_ID = 1006

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
restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["event_item_shop.json"],
})

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

for (const characterId of [LAVU_ID, BARETTA_ID, RAMS_ID]) {
    insertDefaultPlayerCharacterSync(playerId, characterId)
}
for (const characterId of [LAVU_ID, RAMS_ID]) {
    const rarity = characterAssets.getCharacterDataSync(characterId).rarity
    updatePlayerCharacterSync(playerId, characterId, { exp: characterExpCaps[rarity][0] })
    insertPlayerCharacterManaNodesSync(
        playerId,
        characterId,
        Object.keys(characterAssets.getCharacterManaNodesSync(characterId, 1)).map(Number),
    )
}

insertActiveQuest(playerId, {
    questId: LAVU_QUEST_ID,
    category: LAVU_CATEGORY,
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

function finishBattle(fastify, { playId, questId, category, leaderId, elapsedTimeMs }) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/finish",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            play_id: playId,
            quest_id: questId,
            category,
            score: 0,
            elapsed_time_ms: elapsedTimeMs,
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
                    characters: [{ id: leaderId }, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
        }),
    })
}

function requestAwakeProgress(fastify, characterId) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/mission/get_mission_progress",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            category_list: [{ category: 9, character_id: characterId }],
        }),
    })
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
        const finish = await finishBattle(fastify, {
            playId: "lavu-awake-super-plus",
            questId: LAVU_QUEST_ID,
            category: LAVU_CATEGORY,
            leaderId: BARETTA_ID,
            elapsedTimeMs: 1000,
        })
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[LAVU_MISSION_ID].progress, 1)

        const progress = await requestAwakeProgress(fastify, LAVU_ID)
        assert.equal(progress.statusCode, 200, progress.body)
        const progressData = decodeResponse(progress).data
        const missionProgress = progressData.mission_progress_list.find(
            entry => entry.mission_id === LAVU_MISSION_ID,
        )
        assert.equal(missionProgress.mission_id, LAVU_MISSION_ID)
        assert.equal(missionProgress.progress_value >= 1, true)

        insertActiveQuest(playerId, {
            questId: RAMS_QUEST_ID,
            category: RAMS_CATEGORY,
            useBossBoostPoint: false,
            useBoostPoint: false,
            isAutoStartMode: false,
            isMulti: false,
            playId: "rams-awake-hermit-crab-hell",
            continueCount: 0,
        })
        const ramsFinish = await finishBattle(fastify, {
            playId: "rams-awake-hermit-crab-hell",
            questId: RAMS_QUEST_ID,
            category: RAMS_CATEGORY,
            leaderId: RAMS_ID,
            elapsedTimeMs: 90000,
        })
        assert.equal(ramsFinish.statusCode, 200, ramsFinish.body)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[RAMS_MISSION_ID].progress, 1)

        const ramsProgress = await requestAwakeProgress(fastify, RAMS_ID)
        assert.equal(ramsProgress.statusCode, 200, ramsProgress.body)
        const ramsProgressData = decodeResponse(ramsProgress).data
        const ramsMissionProgress = ramsProgressData.mission_progress_list.find(
            entry => entry.mission_id === RAMS_MISSION_ID,
        )
        assert.equal(ramsMissionProgress.mission_id, RAMS_MISSION_ID)
        assert.equal(ramsMissionProgress.progress_value >= 1, true)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("exact awake mission route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
