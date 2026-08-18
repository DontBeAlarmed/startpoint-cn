"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { isDeepStrictEqual } = require("node:util")
const BetterSqlite3 = require("better-sqlite3")

function loadRollbackDependencies() {
    const { activeQuests } = require("../../src/lib/quest/active-quest-service")
    const { finishPayload, startPayload } = require("./non_multi_mixed_battle.cjs")
    const { GACHA_ID } = require("./non_multi_mixed_gacha.cjs")
    const { postCnRequest, requireSuccessfulCnResponse } = require("./non_multi_mixed_http.cjs")
    const {
        SHOP_ITEM_ID,
        SHOP_REWARD_EQUIPMENT_ID,
        SHOP_TYPE,
    } = require("./non_multi_mixed_shop.cjs")
    const { snapshotNonMultiMixedOwnerState } = require("./non_multi_mixed_state_snapshot.cjs")
    const { createStepContext } = require("./non_multi_mixed_workload_setup.cjs")
    const { installSqliteFaultInjection } = require("./sqlite_fault_injection.cjs")
    return {
        activeQuests,
        finishPayload,
        startPayload,
        GACHA_ID,
        postCnRequest,
        requireSuccessfulCnResponse,
        SHOP_ITEM_ID,
        SHOP_REWARD_EQUIPMENT_ID,
        SHOP_TYPE,
        snapshotNonMultiMixedOwnerState,
        createStepContext,
        installSqliteFaultInjection,
    }
}

function captureActiveQuests(activeQuests) {
    return Object.entries(activeQuests)
        .map(([playerId, quest]) => [playerId, structuredClone(quest)])
}

function requireIdentity(pool, entryName) {
    const identity = pool.activeIdentities.find(candidate => candidate.entryName === entryName)
    if (!identity) throw new Error(`missing rollback identity for ${entryName}`)
    return identity
}

function integer(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
    return value
}

function createCases({ pool, mailFixtureByIdentity }, dependencies) {
    const {
        finishPayload,
        startPayload,
        GACHA_ID,
        postCnRequest,
        requireSuccessfulCnResponse,
        SHOP_ITEM_ID,
        SHOP_REWARD_EQUIPMENT_ID,
        SHOP_TYPE,
    } = dependencies
    const battle = requireIdentity(pool, "single-battle")
    const shop = requireIdentity(pool, "shop")
    const gacha = requireIdentity(pool, "gacha")
    const mail = requireIdentity(pool, "mail")
    const mailId = integer(mailFixtureByIdentity[mail.playerId]?.mailId, "rollback mail id")
    return [{
        name: "single-battle",
        identity: battle,
        async prepare(app) {
            const response = await postCnRequest(
                app,
                "/api/index.php/single_battle_quest/start",
                startPayload(battle),
            )
            requireSuccessfulCnResponse(response, "rollback single battle start")
        },
        fault: {
            name: "fail_non_multi_battle_finish",
            table: "players_active_quests",
            event: "BEFORE DELETE",
            when: `OLD.player_id = ${integer(battle.playerId, "battle player id")}`,
            message: "injected single battle finish failure",
            observations: [{
                name: "finished",
                sql: `COALESCE((SELECT finished FROM players_quest_progress
                    WHERE player_id = OLD.player_id AND section = OLD.category
                      AND quest_id = OLD.quest_id), 0)`,
            }],
        },
        request: app => postCnRequest(
            app,
            "/api/index.php/single_battle_quest/finish",
            finishPayload(battle),
        ),
        verifyHits: hits => hits.length === 1 && hits[0].finished === 1,
    }, {
        name: "shop",
        identity: shop,
        fault: {
            name: "fail_non_multi_shop_counter",
            table: "players_shop_purchase_counters",
            event: "BEFORE INSERT",
            when: `NEW.player_id = ${integer(shop.playerId, "shop player id")}
                AND NEW.shop_type = ${SHOP_TYPE} AND NEW.shop_item_id = ${SHOP_ITEM_ID}`,
            message: "injected shop purchase counter failure",
            observations: [{
                name: "bondToken",
                sql: `(SELECT bond_token FROM players WHERE id = NEW.player_id)`,
            }, {
                name: "rewardEquipmentCount",
                sql: `(SELECT COUNT(*) FROM players_equipment
                    WHERE player_id = NEW.player_id AND id = ${SHOP_REWARD_EQUIPMENT_ID})`,
            }],
        },
        request: app => postCnRequest(app, "/api/index.php/shop/buy", {
            viewer_id: shop.viewerId,
            api_count: 1,
            shop_type: SHOP_TYPE,
            shop_item_id: SHOP_ITEM_ID,
            number: 1,
        }),
        verifyHits: hits => hits.length === 1
            && hits[0].bondToken === 450
            && hits[0].rewardEquipmentCount === 1,
    }, {
        name: "gacha",
        identity: gacha,
        fault: {
            name: "fail_non_multi_gacha_mission",
            table: "players_active_mission_counters",
            event: "BEFORE INSERT",
            when: `NEW.player_id = ${integer(gacha.playerId, "gacha player id")}`,
            message: "injected gacha mission counter failure",
            observations: [{
                name: "freeVmoney",
                sql: `(SELECT free_vmoney FROM players WHERE id = NEW.player_id)`,
            }, {
                name: "characterCount",
                sql: `(SELECT COUNT(*) FROM players_characters WHERE player_id = NEW.player_id)`,
            }, {
                name: "exchangePoint",
                sql: `COALESCE((SELECT gacha_exchange_point FROM players_gacha_info
                    WHERE player_id = NEW.player_id AND gacha_id = ${GACHA_ID}), 0)`,
            }],
        },
        request: app => postCnRequest(app, "/api/index.php/gacha/exec", {
            viewer_id: gacha.viewerId,
            gacha_id: GACHA_ID,
            payment_type: 1,
            number_of_exec: 1,
            type: 1,
            api_count: 1,
        }),
        verifyHits: hits => hits.length === 1
            && hits[0].freeVmoney === 850
            && hits[0].characterCount === 1
            && hits[0].exchangePoint === 1,
    }, {
        name: "mail",
        identity: mail,
        fault: {
            name: "fail_non_multi_mail_receive",
            table: "players_mails",
            event: "BEFORE UPDATE OF receive_time",
            when: `OLD.id = ${mailId} AND OLD.player_id = ${integer(mail.playerId, "mail player id")}`,
            message: "injected mail receive failure",
            observations: [{
                name: "itemCount",
                sql: `COALESCE((SELECT amount FROM players_items
                    WHERE player_id = OLD.player_id AND id = 30005), 0)`,
            }],
        },
        request: app => postCnRequest(app, "/api/index.php/mail/receive", {
            viewer_id: mail.viewerId,
            api_count: 1,
            mail_id: mailId,
        }),
        verifyHits: hits => hits.length === 1 && hits[0].itemCount === 2,
    }]
}

async function runRollbackCase({
    runtime,
    seedDirectory,
    suiteDirectory,
    pool,
    mailFixtureByIdentity,
    definition,
    dependencies,
    restoreActiveQuests,
}) {
    const caseRoot = fs.mkdtempSync(path.join(suiteDirectory, `rollback-${definition.name}-`))
    const dataDirectory = path.join(caseRoot, "data")
    const initialActiveQuests = captureActiveQuests(dependencies.activeQuests)
    let database = null
    let databaseOwned = false
    let app = null
    let fault = null
    let result = false
    let primaryError = null
    try {
        fs.cpSync(seedDirectory, dataDirectory, { recursive: true })
        const status = runtime.getDatabaseStatus?.()
        if (status?.open || status?.ready) {
            throw new Error("rollback verification requires the shared database to be closed")
        }
        database = runtime.initializeDatabase({
            paths: runtime.resolveRuntimeDataPaths({ DATA_DIR: dataDirectory }),
            databaseFactory: databasePath => new BetterSqlite3(databasePath),
        })
        databaseOwned = true
        app = await require("./non_multi_mixed_workload_runtime.cjs").createRouteApp(runtime)
        const context = dependencies.createStepContext(runtime, mailFixtureByIdentity, pool.activeIdentities)
        await definition.prepare?.(app, context)
        fault = dependencies.installSqliteFaultInjection(database, definition.fault)
        const beforeDatabase = dependencies.snapshotNonMultiMixedOwnerState(database)
        const beforeMemory = structuredClone(dependencies.activeQuests)
        const response = await definition.request(app, context)
        const afterDatabase = dependencies.snapshotNonMultiMixedOwnerState(database)
        const afterMemory = structuredClone(dependencies.activeQuests)
        result = response.statusCode === 500
            && definition.verifyHits(fault.hits)
            && isDeepStrictEqual(afterDatabase, beforeDatabase)
            && isDeepStrictEqual(afterMemory, beforeMemory)
    } catch (error) {
        primaryError = error
    }
    const cleanupErrors = []
    for (const cleanup of [
        () => fault?.uninstall(),
        async () => { if (app) await app.close() },
        () => { if (databaseOwned) runtime.closeDatabase() },
        () => { if (database?.open) database.close() },
        () => restoreActiveQuests(initialActiveQuests),
        () => fs.rmSync(caseRoot, { recursive: true, force: true }),
    ]) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            primaryError.cause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, `${definition.name} rollback cleanup failed`)
        }
        throw primaryError
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, `${definition.name} rollback cleanup failed`)
    }
    return result
}

async function verifyWriteRollbacks(options) {
    const dependencies = loadRollbackDependencies()
    const result = {}
    const initialActiveQuests = captureActiveQuests(dependencies.activeQuests)
    const restoreActiveQuests = entries => {
        for (const playerId of Object.keys(dependencies.activeQuests)) {
            delete dependencies.activeQuests[playerId]
        }
        for (const [playerId, quest] of entries) {
            dependencies.activeQuests[playerId] = structuredClone(quest)
        }
    }
    try {
        for (const definition of createCases(options, dependencies)) {
            result[definition.name] = await runRollbackCase({
                ...options,
                definition,
                dependencies,
                restoreActiveQuests,
            })
        }
    } finally {
        restoreActiveQuests(initialActiveQuests)
    }
    return result
}

module.exports = { verifyWriteRollbacks }
