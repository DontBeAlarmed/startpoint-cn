#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { RUNTIME_COMMIT_MARKER } = require("./git-object-runtime.cjs")

function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

function collect(runtimeRoot) {
    const runtimeCommit = fs.readFileSync(
        path.join(runtimeRoot, RUNTIME_COMMIT_MARKER),
        "utf8",
    ).trim()
    const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-base-oracle-db-"))
    const previousDataDirectory = process.env.DATA_DIR
    const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
    process.env.DATA_DIR = databaseDirectory
    delete process.env.WDFP_DATABASE_DIR

    const fromRuntime = relativePath => require(path.join(runtimeRoot, relativePath))
    const originalLog = console.log
    console.log = () => {}
    let db = null
    let restoreContent = null
    try {
        const { initializeDatabase } = fromRuntime("src/data")
        const { insertAccountSync } = fromRuntime("src/data/domains/account")
        const {
            getPlayerCategoryMissionsSync,
            updatePlayerCategoryMissionSync,
        } = fromRuntime("src/data/domains/mission")
        const { getPlayerPassCardStateSync } = fromRuntime("src/data/domains/pass-card")
        const {
            getPlayerSync,
            insertDefaultPlayerSync,
            updatePlayerSync,
        } = fromRuntime("src/data/domains/player")
        const database = fromRuntime("src/data/db")
        const { getComputer } = fromRuntime("src/lib/mission/registry")
        const { settleMissionCategories } = fromRuntime("src/lib/mission/settlement")
        const {
            getPassWeekSnapshotType,
            getSnapshot,
        } = fromRuntime("src/lib/mission/snapshot")
        const snapshotHelper = fromRuntime("tools/helpers/install-bundled-gameplay-snapshot.cjs")
        restoreContent = snapshotHelper.installBundledGameplaySnapshot()
        initializeDatabase()
        db = database.getDb()
        const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

        function createPlayer(label) {
            const account = insertAccountSync({
                appId: "wf_cn",
                idpAlias: "",
                idpCode: "oracle",
                idpId: label,
                status: "normal",
            })
            return insertDefaultPlayerSync(account.id).id
        }

        const responsePlayerId = createPlayer("base-response")
        updatePlayerCategoryMissionSync(responsePlayerId, 1, 1, 30)
        const firstResponse = settleMissionCategories(responsePlayerId, [1], evaluationTime)
        const firstPersisted = getPlayerCategoryMissionsSync(responsePlayerId, 1)[1]
        const repeatedResponse = settleMissionCategories(responsePlayerId, [1], evaluationTime)

        const emptyPlayerId = createPlayer("base-empty")
        const emptyResponse = settleMissionCategories(
            emptyPlayerId,
            [{ category: 1, missionIds: [] }],
            evaluationTime,
        )

        const dailyPlayerId = createPlayer("base-daily")
        updatePlayerSync({ id: dailyPlayerId, totalDashes: 10, totalStaminaUsed: 50 })
        db.prepare(`
            INSERT INTO players_mission_battle_counters (
                player_id, single_play_count, single_clear_count,
                multi_play_count, multi_clear_count
            ) VALUES (?, 3, 3, 1, 1)
        `).run(dailyPlayerId)
        const dailyResponse = settleMissionCategories(
            dailyPlayerId,
            [{ category: 2, missionIds: [17] }],
            evaluationTime,
        )

        const passComputer = getComputer(7)
        const originalLegacy = passComputer.buildContext
        const originalSession = passComputer.buildContextFromSession
        const legacyCategories = []
        const sessionCategories = []
        passComputer.buildContext = function trackedLegacy(...args) {
            legacyCategories.push(args[1])
            return originalLegacy.apply(this, args)
        }
        if (originalSession) {
            passComputer.buildContextFromSession = function trackedSession(...args) {
                sessionCategories.push(args[1])
                return originalSession.apply(this, args)
            }
        }
        let weeklySnapshotCreated
        let passReward
        try {
            const weeklyPlayerId = createPlayer("base-pass-weekly")
            updatePlayerSync({ id: weeklyPlayerId, totalStaminaUsed: 40 })
            settleMissionCategories(weeklyPlayerId, [
                { category: 7, eventId: 3, missionIds: [9] },
            ], evaluationTime)
            weeklySnapshotCreated = getSnapshot(
                weeklyPlayerId,
                getPassWeekSnapshotType(3),
            ) !== null

            const passPlayerId = createPlayer("base-pass-reward")
            updatePlayerSync({ id: passPlayerId, totalLoginDays: 5 })
            const passFirstResponse = settleMissionCategories(passPlayerId, [
                { category: 8, eventId: 3, missionIds: [13] },
            ], evaluationTime)
            passReward = {
                firstResponse: passFirstResponse,
                persisted: getPlayerCategoryMissionsSync(passPlayerId, 8)[13],
                passState: getPlayerPassCardStateSync(passPlayerId, 3),
                repeatedResponse: settleMissionCategories(passPlayerId, [
                    { category: 8, eventId: 3, missionIds: [13] },
                ], evaluationTime),
            }
        } finally {
            passComputer.buildContext = originalLegacy
            passComputer.buildContextFromSession = originalSession
        }

        const eventPlayerId = createPlayer("base-event-scope")
        db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (80001, 50, ?)")
            .run(eventPlayerId)
        const eventResponse = settleMissionCategories(
            eventPlayerId,
            [{ category: 4, eventId: 2 }],
            new Date("2020-02-21T04:00:00.000Z"),
        )

        const rollbackPlayerId = createPlayer("base-rollback")
        updatePlayerCategoryMissionSync(rollbackPlayerId, 1, 1, 10)
        const rollbackBefore = {
            mission: getPlayerCategoryMissionsSync(rollbackPlayerId, 1)[1],
            freeVmoney: getPlayerSync(rollbackPlayerId).freeVmoney,
        }
        db.exec(`
            CREATE TRIGGER fail_base_stage
            AFTER INSERT ON players_category_mission_stages
            WHEN NEW.player_id = ${rollbackPlayerId}
            BEGIN
                SELECT RAISE(ABORT, 'injected BASE stage failure');
            END;
        `)
        let injectedError = null
        try {
            settleMissionCategories(rollbackPlayerId, [1], evaluationTime)
        } catch (error) {
            injectedError = error instanceof Error ? error.message : String(error)
        }
        const rollbackAfter = {
            mission: getPlayerCategoryMissionsSync(rollbackPlayerId, 1)[1],
            freeVmoney: getPlayerSync(rollbackPlayerId).freeVmoney,
        }

        return stable({
            runtimeCommit,
            fixedTime: evaluationTime.toISOString(),
            settlement: {
                firstResponse,
                firstPersisted,
                repeatedResponse,
                emptyResponse,
            },
            dailyAllClear: {
                response: dailyResponse,
                persisted: getPlayerCategoryMissionsSync(dailyPlayerId, 2)[17],
            },
            passLegacyBoundary: {
                legacyCategories: [...new Set(legacyCategories)],
                sessionCategories: [...new Set(sessionCategories)],
                weeklySnapshotCreated,
            },
            passReward,
            eventScope: {
                response: eventResponse,
                persisted: getPlayerCategoryMissionsSync(eventPlayerId, 4),
            },
            outerTransactionRollback: {
                injectedError,
                before: rollbackBefore,
                after: rollbackAfter,
                rolledBack: JSON.stringify(rollbackAfter) === JSON.stringify(rollbackBefore),
            },
        })
    } finally {
        try { if (db?.open) db.close() } catch {}
        try { restoreContent?.() } catch {}
        console.log = originalLog
        fs.rmSync(databaseDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    }
}

if (process.argv.length !== 3) {
    throw new Error("mission settlement BASE collector requires one archived runtime root")
}
process.stdout.write(`${JSON.stringify(collect(path.resolve(process.argv[2])), null, 2)}\n`)
