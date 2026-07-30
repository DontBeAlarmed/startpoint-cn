require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-awake-route-db-"))
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
const { getPlayerCharacterAwakeUnlocksSync } = require("../src/data/domains/character_awake")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const characterAssets = require("../src/lib/assets")
const { getCharacterDataSync, getCharacterManaNodesSync } = characterAssets
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
    idpId: `character-awake-route-test-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
insertDefaultPlayerCharacterSync(playerId, 341005)
const rarity = getCharacterDataSync(341005).rarity
updatePlayerCharacterSync(playerId, 341005, { exp: characterExpCaps[rarity][0] })
insertPlayerCharacterManaNodesSync(
    playerId,
    341005,
    Object.keys(getCharacterManaNodesSync(341005, 1)).map(Number),
)
const viewerId = 800000099
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
db.prepare(`
    INSERT INTO players_character_quest_clears (
        player_id, character_id, clear_count, multi_count,
        leader_clear_count, leader_multi_count, leader_power_flip_count
    ) VALUES (?, 341005, 4, 0, 0, 0, 0)
`).run(playerId)

assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 9), {})
insertActiveQuest(playerId, {
    questId: 5,
    category: 15,
    useBossBoostPoint: false,
    useBoostPoint: false,
    isAutoStartMode: false,
    isMulti: false,
    playId: "awake-immediate-unlock",
    continueCount: 0,
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function requestAwakePage(fastify) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/mission/get_mission_progress",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            category_list: [{ category: 9, character_id: 341005 }],
        }),
    })
}

async function finishAwakeBattle(fastify) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/finish",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            quest_id: 5,
            category: 15,
            score: 0,
            elapsed_time_ms: 1000,
            add_mana: 0,
            is_accomplished: true,
            statistics: {
                clear_phase: 1,
                max_combo_count: 0,
                zones: [{
                    damage_deal_total: 0,
                    members: [{ origin_damage: 0 }, null, null],
                }],
                party: {
                    characters: [{ id: 341005 }, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
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
        const finish = await finishAwakeBattle(fastify)
        assert.equal(finish.statusCode, 200, finish.body)
        const finishData = decodeResponse(finish).data
        assert.deepEqual(
            finishData.character_list.find(entry => entry.character_id === 341005)?.mana_board_awake,
            { 1: 1 },
        )
        assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
        assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 9), {})

        const originalPrepare = db.prepare.bind(db)
        const originalGetCharacterDataSync = characterAssets.getCharacterDataSync
        const evaluatedCharacterIds = new Set()
        const queryCounts = {
            characterBatch: 0,
            manaNodeBatch: 0,
            characterSingle: 0,
            manaNodeSingle: 0,
            characterClearSingle: 0,
        }
        db.prepare = sql => {
            const normalized = String(sql).replace(/\s+/g, " ").trim()
            if (normalized.includes("FROM players_characters WHERE player_id = ? AND id = ?")) {
                queryCounts.characterSingle++
            } else if (normalized.includes("FROM players_characters WHERE player_id = ?")) {
                queryCounts.characterBatch++
            }
            if (normalized.includes("FROM players_characters_mana_nodes WHERE character_id = ? AND player_id = ?")) {
                queryCounts.manaNodeSingle++
            } else if (normalized.startsWith("SELECT value, character_id FROM players_characters_mana_nodes WHERE player_id = ?")) {
                queryCounts.manaNodeBatch++
            }
            if (normalized.includes("FROM players_character_quest_clears WHERE player_id = ? AND character_id = ?")) {
                queryCounts.characterClearSingle++
            }
            return originalPrepare(sql)
        }
        characterAssets.getCharacterDataSync = candidateCharacterId => {
            evaluatedCharacterIds.add(Number(candidateCharacterId))
            return originalGetCharacterDataSync(candidateCharacterId)
        }

        let first
        try {
            first = await requestAwakePage(fastify)
        } finally {
            db.prepare = originalPrepare
            characterAssets.getCharacterDataSync = originalGetCharacterDataSync
        }
        assert.equal(first.statusCode, 200)
        assert.deepEqual([...evaluatedCharacterIds], [341005])
        assert.deepEqual(queryCounts, {
            characterBatch: 1,
            manaNodeBatch: 1,
            characterSingle: 0,
            manaNodeSingle: 0,
            characterClearSingle: 0,
        })
        const firstData = decodeResponse(first).data
        assert.deepEqual(
            firstData.mission_progress_list.map(entry => entry.mission_id),
            [3410051, 3410052, 3410053, 3410054],
        )
        assert.deepEqual(
            firstData.mission_info.map(entry => entry.mission_id),
            [3410051, 3410052, 3410053, 3410054],
        )
        assert.deepEqual(firstData.character_list, [])
        assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })

        const persisted = getPlayerCategoryMissionsSync(playerId, 9)
        assert.equal([3410051, 3410052, 3410053, 3410054]
            .every(missionId => persisted[missionId].stages[1] === true), true)

        const repeated = await requestAwakePage(fastify)
        assert.equal(repeated.statusCode, 200)
        const repeatedData = decodeResponse(repeated).data
        assert.deepEqual(repeatedData.mission_info, [])
        assert.deepEqual(repeatedData.item_list, {})
        assert.deepEqual(repeatedData.character_list, [])
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("character awake route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
