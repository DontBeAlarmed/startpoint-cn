#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { isDeepStrictEqual } = require("node:util")
const BetterSqlite3 = require("better-sqlite3")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const FIXED_TIME = "2024-08-14T12:00:00.000Z"
const SCENARIO_NAMES = Object.freeze([
    "load-large-change",
    "load-large-stable",
    "load-new",
    "receive-batch-1",
    "receive-batch-8",
    "receive-batch-32",
    "single-finish-active",
    "single-finish-no-match",
    "story-finish-first",
    "story-finish-repeat",
])
const EXPECTED_UNSUPPORTED_MISSION_IDS = Object.freeze([
    21030,
    25009,
    25010,
    25011,
    25012,
    25013,
    25014,
    25017,
    25018,
    25022,
])
const SNAPSHOT_PATH = path.join(__dirname, "..", "__snapshots__", "active_mission_focused_baseline.json")

function quoteIdentifier(value) {
    return `"${String(value).replaceAll("\"", "\"\"")}"`
}

function sortedRows(rows) {
    return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function snapshotOwner(db, playerId) {
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId)
    if (!player) throw new Error(`player ${playerId} is missing from owner snapshot`)
    const account = db.prepare("SELECT account_id AS accountId FROM players WHERE id = ?").get(playerId)
    const tables = {}
    const tableNames = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map(row => row.name)
    for (const tableName of tableNames) {
        const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
        const names = new Set(columns.map(column => column.name))
        let rows = []
        if (tableName === "players") {
            rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE id = ?`).all(playerId)
        } else if (names.has("player_id")) {
            rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE player_id = ?`).all(playerId)
        } else if (names.has("account_id") && account?.accountId !== undefined) {
            rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE account_id = ?`)
                .all(account.accountId)
        } else if (tableName === "accounts" && names.has("id") && account?.accountId !== undefined) {
            rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE id = ?`).all(account.accountId)
        }
        if (rows.length > 0) tables[tableName] = sortedRows(rows)
    }
    return { tables }
}

function readActiveMissionState(db, playerId) {
    const missions = db.prepare(`
        SELECT id, progress FROM players_active_missions
        WHERE player_id = ? ORDER BY id
    `).all(playerId)
    const stages = db.prepare(`
        SELECT id AS stage, status, mission_id AS missionId
        FROM players_active_missions_stages
        WHERE player_id = ? ORDER BY mission_id, id
    `).all(playerId)
    return { missions, stages }
}

function readAwakeMissionState(db, playerId) {
    const missions = db.prepare(`
        SELECT id, progress FROM players_category_missions
        WHERE player_id = ? AND category = 9 ORDER BY id
    `).all(playerId)
    const stages = db.prepare(`
        SELECT id AS stage, status, mission_id AS missionId
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9 ORDER BY mission_id, id
    `).all(playerId)
    return { missions, stages }
}

function readRewardState(db, playerId) {
    const player = db.prepare(`
        SELECT free_vmoney AS freeVmoney, free_mana AS freeMana, exp_pool AS expPool,
               total_mana_obtained AS totalManaObtained
        FROM players WHERE id = ?
    `).get(playerId)
    return {
        player,
        items: db.prepare(`
            SELECT id, amount FROM players_items WHERE player_id = ? ORDER BY id
        `).all(playerId),
        characters: db.prepare(`
            SELECT id, entry_count AS entryCount, evolution_level AS evolutionLevel,
                   over_limit_step AS overLimitStep, protection, exp, stack,
                   mana_board_index AS manaBoardIndex,
                   ex_boost_status_id AS exBoostStatusId,
                   ex_boost_ability_id_list AS exBoostAbilityIdList,
                   illustration_settings AS illustrationSettings
            FROM players_characters WHERE player_id = ? ORDER BY id
        `).all(playerId),
        equipment: db.prepare(`
            SELECT id, level, enhancement_level AS enhancementLevel, protection, stack
            FROM players_equipment WHERE player_id = ? ORDER BY id
        `).all(playerId),
        degrees: db.prepare(`
            SELECT degree_id AS degreeId FROM players_degrees
            WHERE player_id = ? ORDER BY degree_id
        `).all(playerId),
    }
}

function normalizeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("application/x-msgpack")) {
        return unpack(Buffer.from(response.body, "base64"))
    }
    try { return JSON.parse(response.body) } catch { return { raw: response.body } }
}

function responseContainsMarker(response, marker) {
    if (response?.statusCode !== 500 || typeof marker !== "string" || marker.length === 0) {
        return false
    }
    const candidates = [String(response.body ?? "")]
    try { candidates.push(JSON.stringify(normalizeResponse(response))) } catch { /* raw body remains */ }
    return candidates.some(candidate => candidate.includes(marker))
}

function isInjectedRollback({ response, marker, before, after }) {
    return responseContainsMarker(response, marker) && isDeepStrictEqual(before, after)
}

function restoreObjectEntries(target, entries) {
    for (const key of Object.keys(target)) delete target[key]
    for (const [key, value] of entries) target[key] = value
}

function combineCleanupErrors(primaryError, cleanupErrors) {
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && !(primaryError instanceof Error)) {
            return new AggregateError(
                [primaryError, ...cleanupErrors],
                "Active Mission isolated run and cleanup failed",
            )
        }
        if (cleanupErrors.length > 0) {
            const cleanupCause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Active Mission isolated cleanup failed")
            if (primaryError.cause === undefined) primaryError.cause = cleanupCause
            else primaryError.cleanupCause = cleanupCause
        }
        return primaryError
    }
    if (cleanupErrors.length === 1) return cleanupErrors[0]
    if (cleanupErrors.length > 1) {
        return new AggregateError(cleanupErrors, "Active Mission isolated cleanup failed")
    }
    return null
}

function behaviorSummary({ response, db, playerId, unsupportedMissionIds = EXPECTED_UNSUPPORTED_MISSION_IDS }) {
    const decoded = response ? normalizeResponse(response) : {}
    const data = decoded.data ?? {}
    return {
        statusCode: response?.statusCode ?? 500,
        activeMissionDelta: data.active_mission_list ?? [],
        allActiveMissionState: readActiveMissionState(db, playerId),
        awakeMissionState: readAwakeMissionState(db, playerId),
        rewardState: readRewardState(db, playerId),
        unsupportedMissionIds: [...unsupportedMissionIds],
    }
}

function createRuntime({ fastifyFactory = Fastify } = {}) {
    const data = require("../../../src/data")
    const { getDb } = require("../../../src/data/db")
    const accountDomain = require("../../../src/data/domains/account")
    const playerDomain = require("../../../src/data/domains/player")
    const missionDomain = require("../../../src/data/domains/mission")
    const { resolveRuntimeDataPaths } = require("../../../src/runtime/data-paths")
    const { getTimeOffset, setServerTimeOffset } = require("../../../src/utils")
    const { installBundledGameplaySnapshot } = require("../../helpers/install-bundled-gameplay-snapshot.cjs")
    const { activeQuests } = require("../../../src/lib/quest/active-quest-service")

    async function runIsolated({ name, tableOverrides = {}, setup, execute }) {
        const databaseStatus = data.getDatabaseStatus()
        if (databaseStatus.open || databaseStatus.ready) {
            throw new Error("Active Mission isolated run refuses to use an open caller database")
        }
        const activeQuestEntries = Object.entries(activeQuests)
        let directory = null
        let originalTimeOffset
        let hasOriginalTimeOffset = false
        let restoreContent = null
        let databaseInitialized = false
        const apps = []
        let primaryError = null
        let outcome
        const cleanupErrors = []
        try {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), `active-mission-focused-${name}-`))
            originalTimeOffset = getTimeOffset()
            hasOriginalTimeOffset = true
            restoreContent = installBundledGameplaySnapshot({ tableOverrides })
            setServerTimeOffset(Date.parse(FIXED_TIME) - Date.now())
            data.initializeDatabase({
                paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
                databaseFactory: databasePath => new BetterSqlite3(databasePath),
            })
            databaseInitialized = true
            const db = getDb()
            const bindViewer = (playerId, viewerId) => {
                const account = db.prepare(
                    "SELECT account_id AS accountId FROM players WHERE id = ?",
                ).get(playerId)
                if (!account) throw new Error(`player ${playerId} has no account`)
                db.prepare(`
                    INSERT INTO sessions (token, account_id, expires, type)
                    VALUES (?, ?, ?, 2)
                `).run(String(viewerId), account.accountId, "2099-12-31T23:59:59.000Z")
                playerDomain.updatePlayerSync({
                    id: playerId,
                    lastLoginTime: new Date(FIXED_TIME),
                })
                return { playerId, viewerId }
            }
            const createPlayer = (label, viewerId) => {
                const account = accountDomain.insertAccountSync({
                    appId: "wf_cn",
                    idpAlias: "",
                    idpCode: "active-mission-focused",
                    idpId: `${label}-${viewerId}`,
                    status: "normal",
                })
                return bindViewer(playerDomain.insertDefaultPlayerSync(account.id).id, viewerId)
            }
            const createFixturePlayer = (profile, viewerId) => {
                const { selectActiveMissionFixture } = require("./fixture.cjs")
                return bindViewer(selectActiveMissionFixture(profile).create(), viewerId)
            }
            const createApp = async (route, options) => {
                const app = fastifyFactory({ logger: false })
                apps.push(app)
                app.addContentTypeParser(
                    "application/x-www-form-urlencoded",
                    { parseAs: "string" },
                    (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
                )
                app.addHook("onSend", (_request, reply, payload, done) => {
                    if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
                        done(null, pack(payload).toString("base64"))
                        return
                    }
                    done(null, payload)
                })
                await app.register(route, options)
                await app.ready()
                return app
            }
            const player = await setup({
                db,
                createPlayer,
                createFixturePlayer,
                createApp,
                missionDomain,
            })
            outcome = await execute({
                db,
                player,
                createApp,
                missionDomain,
                snapshotOwner: () => snapshotOwner(db, player.playerId),
                snapshotActiveMissionState: () => readActiveMissionState(db, player.playerId),
            })
        } catch (error) {
            primaryError = error
        } finally {
            for (const app of apps.reverse()) {
                try { await app.close() } catch (error) { cleanupErrors.push(error) }
            }
            try { restoreObjectEntries(activeQuests, activeQuestEntries) } catch (error) {
                cleanupErrors.push(error)
            }
            if (databaseInitialized) {
                try { data.closeDatabase() } catch (error) { cleanupErrors.push(error) }
            }
            if (restoreContent !== null) {
                try { restoreContent() } catch (error) { cleanupErrors.push(error) }
            }
            if (hasOriginalTimeOffset) {
                try { setServerTimeOffset(originalTimeOffset) } catch (error) { cleanupErrors.push(error) }
            }
            if (directory !== null) {
                try { fs.rmSync(directory, { recursive: true, force: true }) } catch (error) {
                    cleanupErrors.push(error)
                }
            }
        }
        const finalError = combineCleanupErrors(primaryError, cleanupErrors)
        if (finalError !== null) throw finalError
        return outcome
    }

    return {
        runIsolated,
        behaviorSummary,
        encodeRequest: body => pack(body).toString("base64"),
        fixedTime: FIXED_TIME,
        isInjectedRollback,
        ownersEqual: isDeepStrictEqual,
    }
}

function assertBehaviorSummary(name, behavior) {
    assert.deepEqual(Object.keys(behavior).sort(), [
        "activeMissionDelta",
        "allActiveMissionState",
        "awakeMissionState",
        "rewardState",
        "statusCode",
        "unsupportedMissionIds",
    ].sort(), `${name}: behavior fields`)
    assert.equal(behavior.statusCode, 200, `${name}: statusCode`)
    assert.equal(Array.isArray(behavior.unsupportedMissionIds), true, `${name}: unsupportedMissionIds`)
    assert.deepEqual(behavior.unsupportedMissionIds, EXPECTED_UNSUPPORTED_MISSION_IDS, name)
}

async function runFocusedScenarios() {
    const originalConsole = { log: console.log, warn: console.warn, error: console.error }
    console.log = console.warn = console.error = () => {}
    try {
        const runtime = createRuntime()
        const load = require("./scenarios-load.cjs")
        const finish = require("./scenarios-finish.cjs")
        const receive = require("./scenarios-receive.cjs")
        const runners = {
            "load-large-change": () => load.runLoadScenario(runtime, "load-large-change"),
            "load-large-stable": () => load.runLoadScenario(runtime, "load-large-stable"),
            "load-new": () => load.runLoadScenario(runtime, "load-new"),
            "receive-batch-1": () => receive.runReceiveScenario(runtime, 1),
            "receive-batch-8": () => receive.runReceiveScenario(runtime, 8),
            "receive-batch-32": () => receive.runReceiveScenario(runtime, 32),
            "single-finish-active": () => finish.runSingleFinishScenario(runtime, "single-finish-active"),
            "single-finish-no-match": () => finish.runSingleFinishScenario(runtime, "single-finish-no-match"),
            "story-finish-first": () => finish.runStoryFinishScenario(runtime, "story-finish-first"),
            "story-finish-repeat": () => finish.runStoryFinishScenario(runtime, "story-finish-repeat"),
        }
        const scenarios = {}
        for (const name of SCENARIO_NAMES) {
            scenarios[name] = await runners[name]()
            assertBehaviorSummary(name, scenarios[name])
        }
        const rollback = {
            load: await load.runLoadRollback(runtime),
            singleFinish: await finish.runSingleFinishRollback(runtime),
            storyFinish: await finish.runStoryFinishRollback(runtime),
            receive: await receive.runReceiveRollback(runtime),
        }
        return {
            scenarios,
            unsupportedMissionIds: [...EXPECTED_UNSUPPORTED_MISSION_IDS],
            rollback,
        }
    } finally {
        Object.assign(console, originalConsole)
    }
}

function parseArgs(argv) {
    if (argv.length === 0) return { write: false }
    if (argv.length === 1 && argv[0] === "--write") return { write: true }
    throw new Error(`unknown argument: ${argv.join(" ")}`)
}

function readSnapshot() {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"))
}

function validateReport(report) {
    assert.deepEqual(Object.keys(report).sort(), [
        "rollback",
        "scenarios",
        "unsupportedMissionIds",
    ], "active mission report fields changed")
    assert.deepEqual(Object.keys(report.scenarios), SCENARIO_NAMES, "active mission scenario set changed")
    assert.deepEqual(report.unsupportedMissionIds, EXPECTED_UNSUPPORTED_MISSION_IDS)
    for (const [name, behavior] of Object.entries(report.scenarios)) {
        assertBehaviorSummary(name, behavior)
    }
    assert.deepEqual(Object.keys(report.rollback), ["load", "singleFinish", "storyFinish", "receive"])
    for (const [owner, rolledBack] of Object.entries(report.rollback)) {
        assert.equal(rolledBack, true, `${owner}: rollback`)
    }
}

function serializeSnapshot(report) {
    validateReport(report)
    return `${JSON.stringify(report, null, 2)}\n`
}

async function main() {
    const { write } = parseArgs(process.argv.slice(2))
    const report = await runFocusedScenarios()
    validateReport(report)
    if (write) {
        fs.writeFileSync(SNAPSHOT_PATH, serializeSnapshot(report), "utf8")
        return
    }
    if (!fs.existsSync(SNAPSHOT_PATH)) {
        throw new Error(`active mission focused snapshot is missing: ${SNAPSHOT_PATH}`)
    }
    const snapshot = readSnapshot()
    validateReport(snapshot)
    assert.deepEqual(snapshot, report, "active mission focused baseline changed; use --write after review")
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    EXPECTED_UNSUPPORTED_MISSION_IDS,
    FIXED_TIME,
    SCENARIO_NAMES,
    SNAPSHOT_PATH,
    behaviorSummary,
    createRuntime,
    isInjectedRollback,
    parseArgs,
    runFocusedScenarios,
    serializeSnapshot,
    validateReport,
}
