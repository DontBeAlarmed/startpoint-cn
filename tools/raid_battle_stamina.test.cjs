"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raid-battle-stamina-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

// CDN raid_event_quest col68 carries battle_stamina_cost (4001 = 8); the
// bundled quest_entry_costs snapshot predates the raid table registration, so
// inject the CDN-derived row the way content:sync derives it. The bundled
// raid quest snapshot also predates quest window conversion, so inject the
// windows the current converter derives for 4001 (2024-05-23 12:00 ..
// 2024-06-06 23:59:59 UTC+8).
const bundledEntryCosts = require("../assets/quest_entry_costs.json")
const entryCostOverride = {
    ...bundledEntryCosts,
    "23_4001": { itemId: 0, itemCount: 0, stamina: 8 },
}
const bundledRaidQuests = require("../assets/raid_event_quest.json")
const raidQuestOverride = {
    ...bundledRaidQuests,
    "4001": {
        ...bundledRaidQuests["4001"],
        availableFromMs: 1716436800000,
        availableUntilMs: 1717689599000,
    },
}

let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot({
    tableOverrides: {
        "quest_entry_costs.json": entryCostOverride,
        "raid_event_quest.json": raidQuestOverride,
    },
})

const { initializeDatabase, closeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { deletePlayerActiveQuestSync, getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { activeQuests, clearPublishedActiveQuest } = require("../src/lib/quest/active-quest-service")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const raidEventRoutes = require("../src/routes/api/raidEvent").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
function setServerTime(isoTimestamp) {
    setServerTimeOffset(Date.parse(isoTimestamp) - Date.now())
}
// Raid event 4 (quests 4001..4004) is open 2024-05-23 12:00 .. 2024-06-06.
setServerTime("2024-05-28T12:00:00.000Z")

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `raid-battle-stamina-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000614

db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function setStamina(value) {
    updatePlayerSync({ id: playerId, stamina: value, staminaHealTime: new Date() })
}

function currentStamina() {
    return computeRealTimeStamina(getPlayerSync(playerId))
}

function resetBattleState() {
    deletePlayerActiveQuestSync(playerId)
    clearPublishedActiveQuest(playerId)
}

async function startBattle(questId, { isAutoStartMode = false, playId } = {}) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/event/raid/battle/start",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({
            viewer_id: viewerId,
            api_count: 1,
            quest_id: questId,
            party_group_id: 1,
            use_auto_start_point: false,
            is_auto_start_mode: isAutoStartMode,
            play_id: playId ?? `raid-stamina-${questId}-${randomUUID()}`,
        }).toString("base64"),
    })
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("application/x-msgpack")) {
        return unpack(Buffer.from(response.body, "base64"))
    }
    return response.json()
}

const fastify = Fastify({ logger: false })
fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
)
registerCnMsgpackOnSend(fastify, encodeCnMsgpackPayload)

test("raid battle/start deducts the CDN battle_stamina_cost atomically", async () => {
    await fastify.register(raidEventRoutes, { prefix: "/api/index.php/event/raid" })
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.ready()
    resetBattleState()
    setStamina(20)

    const started = await startBattle(4001)
    assert.equal(started.statusCode, 200, started.body)

    // CDN raid_event_quest col68 (quest_entry_costs 23_4001) is 8.
    assert.equal(currentStamina(), 12)
    const stored = getPlayerSync(playerId)
    assert.equal(stored.stamina, 12)
    assert.equal(stored.totalStaminaUsed, 0, "totalStaminaUsed is only committed on finish")
    const activeQuest = getPlayerActiveQuestSync(playerId)
    assert.notEqual(activeQuest, null)
    assert.equal(activeQuest.category, 23)
    assert.equal(activeQuests[playerId].staminaCost, 8)
})

test("raid battle/start with insufficient stamina consumes nothing and creates no quest", async () => {
    resetBattleState()
    setStamina(7)
    const itemsBefore = db.prepare(
        "SELECT COUNT(*) AS count FROM players_items WHERE player_id = ?",
    ).get(playerId).count

    const started = await startBattle(4001)

    assert.equal(started.statusCode, 400, started.body)
    assert.equal(getPlayerActiveQuestSync(playerId), null)
    assert.equal(activeQuests[playerId], undefined)
    assert.equal(currentStamina(), 7)
    assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM players_items WHERE player_id = ?",
    ).get(playerId).count, itemsBefore)
})

test("raid battle/start while an active quest exists returns 400, not a sqlite 500", async () => {
    resetBattleState()
    setStamina(30)
    const firstPlayId = `raid-stamina-dup-${randomUUID()}`

    const first = await startBattle(4001, { playId: firstPlayId })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(currentStamina(), 22)

    const second = await startBattle(4001)
    assert.equal(second.statusCode, 400, second.body)
    assert.equal(currentStamina(), 22, "rejected duplicate start must not consume stamina again")
    const activeQuest = getPlayerActiveQuestSync(playerId)
    assert.notEqual(activeQuest, null)
    assert.equal(activeQuest.playId, firstPlayId, "the first start stays authoritative")
})

test("auto-start raid battle with insufficient stamina stops with result_code 4050", async () => {
    resetBattleState()
    setStamina(7)

    const started = await startBattle(4001, { isAutoStartMode: true })

    assert.equal(started.statusCode, 200, started.body)
    const decoded = decodeResponse(started)
    assert.equal(decoded.data_headers.result_code, 4050)
    assert.equal(getPlayerActiveQuestSync(playerId), null)
    assert.equal(activeQuests[playerId], undefined)
    assert.equal(currentStamina(), 7)
})

test("raid finish commits the prepaid stamina as totalStaminaUsed", async () => {
    resetBattleState()
    // A high rank keeps the finish reward from crossing a degree boundary,
    // whose refill would legitimately add stamina on top of the entry cost.
    updatePlayerSync({ id: playerId, rankPoint: 1000000 })
    setStamina(30)
    const playId = `raid-finish-commit-${randomUUID()}`

    const started = await startBattle(4001, { playId })
    assert.equal(started.statusCode, 200, started.body)
    assert.equal(currentStamina(), 22)

    const finished = await fastify.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/finish",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({
            viewer_id: viewerId,
            play_id: playId,
            quest_id: 4001,
            category: 23,
            score: 0,
            elapsed_time_ms: 1000,
            add_mana: 0,
            is_accomplished: true,
            is_restored: false,
            continue_count: 0,
            api_count: 1,
            statistics: {
                clear_phase: 1,
                max_combo_count: 0,
                zones: [],
                party: {
                    characters: [{ id: 1 }, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
        }).toString("base64"),
    })
    assert.equal(finished.statusCode, 200, finished.body)
    assert.equal(getPlayerActiveQuestSync(playerId), null, "finish clears the active quest")
    const stored = getPlayerSync(playerId)
    assert.equal(stored.totalStaminaUsed, 8, "committed start cost lands on totalStaminaUsed")
    assert.equal(stored.stamina, 22, "finish itself does not deduct stamina again")
})

test("out-of-period raid battle/start keeps the 4050 channel without side effects", async () => {
    resetBattleState()
    setStamina(20)
    setServerTime("2024-08-14T12:00:00.000Z")
    try {
        const started = await startBattle(4001)
        assert.equal(started.statusCode, 200, started.body)
        const decoded = decodeResponse(started)
        assert.equal(decoded.data_headers.result_code, 4050)
        assert.equal(getPlayerActiveQuestSync(playerId), null)
        assert.equal(activeQuests[playerId], undefined)
        assert.equal(currentStamina(), 20)
    } finally {
        setServerTime("2024-05-28T12:00:00.000Z")
    }
})

after(async () => {
    await fastify.close()
    closeDatabase()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
