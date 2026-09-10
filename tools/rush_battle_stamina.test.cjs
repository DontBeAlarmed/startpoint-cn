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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rush-battle-stamina-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getDefaultPlayerRushEventSync,
    insertPlayerRushEventSync,
    updatePlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { deletePlayerActiveQuestSync, getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { activeQuests, clearPublishedActiveQuest } = require("../src/lib/quest/active-quest-service")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const { RushEventFolder } = require("../src/lib/types")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const rushEventRoutes = require("../src/routes/api/rushEvent").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `rush-battle-stamina-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000512
const eventId = 700007
const firstQuestId = 700007001

db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(eventId))

function setStamina(value) {
    updatePlayerSync({ id: playerId, stamina: value, staminaHealTime: new Date() })
}

function currentStamina() {
    return computeRealTimeStamina(getPlayerSync(playerId))
}

function resetBattleState() {
    deletePlayerActiveQuestSync(playerId)
    clearPublishedActiveQuest(playerId)
    updatePlayerRushEventSync(playerId, { eventId, activeRushBattleFolderId: null })
}

async function post(url, body) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
}

async function selectFolder(folderId) {
    return post("/api/index.php/event/rush/select_folder", {
        viewer_id: viewerId,
        api_count: 1,
        event_id: eventId,
        folder_id: folderId,
    })
}

async function startBattle(questId, { isAutoStartMode = false, partyId = 1 } = {}) {
    return post("/api/index.php/event/rush/battle/start", {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: questId,
        party_id: partyId,
        is_auto_start_mode: isAutoStartMode,
        play_id: `rush-stamina-${questId}-${randomUUID()}`,
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

test("rush battle/start deducts the CDN battle_stamina_cost atomically", async () => {
    await fastify.register(rushEventRoutes, { prefix: "/api/index.php/event/rush" })
    await fastify.ready()
    resetBattleState()
    setStamina(20)
    assert.equal(await selectFolder(RushEventFolder.INTERMEDIATE).then(
        response => response.statusCode,
    ), 200)

    const started = await startBattle(firstQuestId)
    assert.equal(started.statusCode, 200, started.body)

    // CDN quest_entry_costs 24_700007001 carries battle_stamina_cost = 4.
    assert.equal(currentStamina(), 16)
    const stored = getPlayerSync(playerId)
    assert.equal(stored.stamina, 16)
    assert.equal(stored.totalStaminaUsed, 0, "totalStaminaUsed is only committed on finish")
    const activeQuest = getPlayerActiveQuestSync(playerId)
    assert.notEqual(activeQuest, null)
    assert.equal(activeQuests[playerId].staminaCost, 4)
    assert.equal(stored.partySlot, 1, "start records the selected party slot")
})

test("rush battle/start with insufficient stamina consumes nothing and creates no quest", async () => {
    resetBattleState()
    setStamina(3)
    assert.equal(await selectFolder(RushEventFolder.INTERMEDIATE).then(
        response => response.statusCode,
    ), 200)
    const itemsBefore = db.prepare(
        "SELECT COUNT(*) AS count FROM players_items WHERE player_id = ?",
    ).get(playerId).count

    const started = await startBattle(firstQuestId)

    assert.equal(started.statusCode, 400, started.body)
    assert.equal(getPlayerActiveQuestSync(playerId), null)
    assert.equal(activeQuests[playerId], undefined)
    assert.equal(currentStamina(), 3)
    assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM players_items WHERE player_id = ?",
    ).get(playerId).count, itemsBefore)
})

test("rush battle/start applies the active stamina campaign rate", async () => {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: {
            "stamina_campaign.json": {
                "99900001": [[
                    "0",
                    "2024-08-01 00:00:00",
                    "2024-12-31 23:59:59",
                    "",
                    "",
                    "0.5",
                    "17",
                    "(None)",
                    "(None)",
                    "(None)",
                ]],
            },
        },
    })
    try {
        resetBattleState()
        setStamina(20)
        assert.equal(await selectFolder(RushEventFolder.INTERMEDIATE).then(
            response => response.statusCode,
        ), 200)

        const started = await startBattle(firstQuestId)
        assert.equal(started.statusCode, 200, started.body)

        // Type-wide rush campaign at rate 0.5: floor(4 * 0.5) = 2.
        assert.equal(currentStamina(), 18)
        assert.equal(getPlayerActiveQuestSync(playerId).staminaCost, 2)
    } finally {
        restoreContentSnapshot()
        restoreContentSnapshot = installBundledGameplaySnapshot()
    }
})

test("auto-start rush battle with insufficient stamina stops with result_code 4050", async () => {
    resetBattleState()
    setStamina(3)
    assert.equal(await selectFolder(RushEventFolder.INTERMEDIATE).then(
        response => response.statusCode,
    ), 200)

    const started = await startBattle(firstQuestId, { isAutoStartMode: true })

    assert.equal(started.statusCode, 200, started.body)
    const decoded = decodeResponse(started)
    assert.equal(decoded.data_headers.result_code, 4050)
    assert.equal(getPlayerActiveQuestSync(playerId), null)
    assert.equal(activeQuests[playerId], undefined)
    assert.equal(currentStamina(), 3)
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
