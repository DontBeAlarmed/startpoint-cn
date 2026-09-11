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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "open-period-boundaries-"))
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
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    getDefaultPlayerRushEventSync,
    insertPlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const rushEventRoutes = require("../src/routes/api/rushEvent").default
const raidEventRoutes = require("../src/routes/api/raidEvent").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
// Frozen CN server time: 2024-08-14T12:00:00Z.
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()

const IN_WINDOW = { availableFromMs: Date.parse("2024-08-01T00:00:00Z"), availableUntilMs: Date.parse("2024-12-31T23:59:59Z") }
const EXPIRED_WINDOW = { availableFromMs: Date.parse("2024-07-01T00:00:00Z"), availableUntilMs: Date.parse("2024-08-10T00:00:00Z") }

function questTableWithWindow(tableName, questId, window) {
    const table = structuredClone(require(`../assets/${tableName}.json`))
    table[String(questId)] = {
        ...table[String(questId)],
        ...window,
    }
    return table
}

function withQuestWindows(tableName, questId, window) {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { [`${tableName}.json`]: questTableWithWindow(tableName, questId, window) },
    })
}

function resetSnapshot() {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot()
}

async function createPlayer(label, viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    updatePlayerSync({ id: playerId, stamina: 100, staminaHealTime: new Date() })
    return playerId
}

async function selectRushFolder(app, viewerId, eventId = 700007) {
    return post(app, "/api/index.php/event/rush/select_folder", {
        viewer_id: viewerId,
        api_count: 1,
        event_id: eventId,
        folder_id: 1,
    })
}

async function post(app, url, body) {
    const response = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
    const contentType = String(response.headers["content-type"] ?? "")
    let decoded
    try {
        decoded = contentType.includes("application/x-msgpack")
            ? unpack(Buffer.from(response.body, "base64"))
            : response.json()
    } catch (error) {
        decoded = { data_headers: {}, data: { body: String(response.body).slice(0, 300) } }
    }
    if (response.statusCode === 404) console.error("404-BODY:", String(response.body).slice(0, 200))
    return { statusCode: response.statusCode, headers: decoded.data_headers, data: decoded.data }
}

const MAIN_QUEST_ID = 1001002
const RUSH_QUEST_ID = 700007001

function buildApps() {
    const apps = {}
    const build = (routes, prefix, name) => {
        const app = Fastify({ logger: false })
        app.addContentTypeParser(
            "application/x-www-form-urlencoded",
            { parseAs: "string" },
            (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
        )
        registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
        app.register(routes, { prefix })
        apps[name] = app
    }
    build(singleBattleRoutes, "/api/index.php/single_battle_quest", "single")
    build(rushEventRoutes, "/api/index.php/event/rush", "rush")
    build(raidEventRoutes, "/api/index.php/event/raid", "raid")
    return apps
}

test.before(async () => {
    const apps = buildApps()
    for (const app of Object.values(apps)) await app.ready()
    globalThis.__openPeriodApps = apps
})

test.after(async () => {
    for (const app of Object.values(globalThis.__openPeriodApps ?? {})) await app.close()
    closeDatabase()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("single start rejects an out-of-window quest with result_code 4050", async () => {
    const app = globalThis.__openPeriodApps.single
    const viewerId = 940000001
    await createPlayer("single-expired", viewerId)
    withQuestWindows("main_quest", MAIN_QUEST_ID, EXPIRED_WINDOW)
    try {
        const before = computeRealTimeStamina(getPlayerSync(await resolveSinglePlayerId(viewerId)))
        const result = await post(app, "/api/index.php/single_battle_quest/start", {
            viewer_id: viewerId,
            api_count: 1,
            quest_id: MAIN_QUEST_ID,
            category: 1,
            party_id: 1,
            play_id: "open-period-single-expired",
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
        })
        assert.equal(result.statusCode, 200)
        assert.equal(result.headers.result_code, 4050)
        assert.equal(getPlayerActiveQuestSync(await resolveSinglePlayerId(viewerId)), null)
        assert.equal(computeRealTimeStamina(getPlayerSync(await resolveSinglePlayerId(viewerId))), before)
    } finally {
        resetSnapshot()
    }
})

test("single start inside the window is unaffected", async () => {
    const app = globalThis.__openPeriodApps.single
    const viewerId = 940000002
    await createPlayer("single-in-window", viewerId)
    withQuestWindows("main_quest", MAIN_QUEST_ID, IN_WINDOW)
    try {
        const result = await post(app, "/api/index.php/single_battle_quest/start", {
            viewer_id: viewerId,
            api_count: 1,
            quest_id: MAIN_QUEST_ID,
            category: 1,
            party_id: 1,
            play_id: "open-period-single-in-window",
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
        })
        assert.equal(result.statusCode, 200)
        assert.notEqual(result.headers.result_code, 4050)
        assert.notEqual(getPlayerActiveQuestSync(await resolveSinglePlayerId(viewerId)), null)
    } finally {
        resetSnapshot()
    }
})

test("rush battle/start rejects an out-of-window quest with result_code 4050", async () => {
    const app = globalThis.__openPeriodApps.rush
    const viewerId = 940000003
    const playerId = await createPlayer("rush-expired", viewerId)
    insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(700007))
    withQuestWindows("rush_event_quest", RUSH_QUEST_ID, EXPIRED_WINDOW)
    try {
        const before = computeRealTimeStamina(getPlayerSync(playerId))
        await selectRushFolder(app, viewerId)
        const result = await post(app, "/api/index.php/event/rush/battle/start", {
            viewer_id: viewerId,
            api_count: 1,
            quest_id: RUSH_QUEST_ID,
            party_id: 1,
            is_auto_start_mode: false,
            play_id: "open-period-rush-expired",
        })
        assert.equal(result.statusCode, 200)
        assert.equal(result.headers.result_code, 4050)
        assert.equal(getPlayerActiveQuestSync(playerId), null)
        assert.equal(computeRealTimeStamina(getPlayerSync(playerId)), before)
    } finally {
        resetSnapshot()
    }
})

test("rush finish reports is_out_of_period from the quest window", async () => {
    const app = globalThis.__openPeriodApps.single
    const viewerId = 940000004
    const playerId = await createPlayer("rush-finish-expired", viewerId)
    const singleApp = app
    insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(700007))
    // Start inside the window, then let the window close before finishing.
    withQuestWindows("rush_event_quest", RUSH_QUEST_ID, IN_WINDOW)
    await selectRushFolder(globalThis.__openPeriodApps.rush, viewerId)
    const started = await post(globalThis.__openPeriodApps.rush, "/api/index.php/event/rush/battle/start", {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: RUSH_QUEST_ID,
        party_id: 1,
        is_auto_start_mode: false,
        play_id: "open-period-rush-finish",
    })
    assert.equal(started.statusCode, 200, JSON.stringify(started))
    assert.notEqual(started.headers.result_code, 4050)
    assert.notEqual(getPlayerActiveQuestSync(playerId), null)

    resetSnapshot()
    withQuestWindows("rush_event_quest", RUSH_QUEST_ID, EXPIRED_WINDOW)
    try {
        const finished = await post(singleApp, "/api/index.php/single_battle_quest/finish", {
            viewer_id: viewerId,
            api_count: 2,
            play_id: "open-period-rush-finish",
            quest_id: RUSH_QUEST_ID,
            category: 24,
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
                    use_power_flip_count: 0,
                    use_dash_count: 0,
                    use_skill_count: 0,
                    members: [{ origin_damage: 0 }, null, null],
                }],
                party: {
                    characters: [{ id: 1 }, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
        })
        if (finished.statusCode !== 200) console.error("FINISH-BODY:", JSON.stringify(finished).slice(0, 300))
        assert.equal(finished.statusCode, 200, JSON.stringify(finished))
        assert.equal(finished.data.rush_event.is_out_of_period, true)
    } finally {
        resetSnapshot()
    }
})

test("raid battle/start rejects an out-of-window quest with result_code 4050", async () => {
    const app = globalThis.__openPeriodApps.raid
    const viewerId = 940000005
    const playerId = await createPlayer("raid-expired", viewerId)
    const raidQuests = require("../assets/raid_event_quest.json")
    const raidQuestId = Number(Object.keys(raidQuests).find(id => raidQuests[id].eventId != null))
    withQuestWindows("raid_event_quest", raidQuestId, EXPIRED_WINDOW)
    try {
        const result = await post(app, "/api/index.php/event/raid/battle/start", {
            viewer_id: viewerId,
            api_count: 1,
            quest_id: raidQuestId,
            party_group_id: 1,
            play_id: "open-period-raid-expired",
            use_auto_start_point: false,
            is_auto_start_mode: false,
        })
        assert.equal(result.statusCode, 200)
        assert.equal(result.headers.result_code, 4050)
        assert.equal(getPlayerActiveQuestSync(playerId), null)
    } finally {
        resetSnapshot()
    }
})

async function resolveSinglePlayerId(viewerId) {
    const row = getDb().prepare(`
        SELECT p.id AS playerId
        FROM sessions s
        JOIN accounts a ON a.id = s.account_id
        JOIN players p ON p.account_id = a.id
        WHERE s.token = ?
    `).get(String(viewerId))
    return row.playerId
}
