"use strict"

require("ts-node/register/transpile-only")

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const BetterSqlite3 = require("better-sqlite3")

const { closeDatabase, initializeDatabase } = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { getPlayerItemSync, setPlayerItemSync } = require("../../src/data/domains/item")
const { getPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
const {
    activeQuests,
    clearPublishedActiveQuest,
    insertActiveQuest,
} = require("../../src/lib/quest/active-quest-service")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
const {
    installBundledGameplaySnapshot,
} = require("../helpers/install-bundled-gameplay-snapshot.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")
const { SINGLE_BATTLE_FIXED_TIME } = require("./single_battle_settlement_admission.cjs")
const fixture = require("./single_battle_settlement_fixture.cjs")
const { createStaminaHealTimeTracker } = require("./single_battle_settlement_time.cjs")
const {
    createRequestSqlRunner,
    createSingleBattleApp,
} = require("./single_battle_settlement_request_runner.cjs")

async function withSingleBattleHarness(name, operation, {
    additionalSettlementOverride,
    tableOverrides = {},
} = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `single-battle-settlement-${name}-`))
    const counter = createSqlCounter()
    const measurementState = { active: false }
    const originalTimeOffset = getTimeOffset()
    const originalConsole = { error: console.error, log: console.log, warn: console.warn }
    let app
    let restoreContent = () => {}
    let restoreAdditionalSettlement = () => {}
    let primaryError = null
    let result
    try {
        console.error = console.log = console.warn = () => {}
        setServerTimeOffset(Date.parse(SINGLE_BATTLE_FIXED_TIME) - Date.now())
        restoreContent = installBundledGameplaySnapshot({
            tableOverrides: {
                "score_reward.json": fixture.DETERMINISTIC_SCORE_REWARDS,
                "additional_reward_rules.json": fixture.DETERMINISTIC_ADDITIONAL_REWARDS,
                ...tableOverrides,
            },
        })
        initializeDatabase({
            paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose: sql => { if (measurementState.active) counter.observe(sql) },
            }),
        })
        const playerId = fixture.createFixturePlayer()
        if (additionalSettlementOverride !== undefined) {
            const additionalReward = require("../../src/lib/additional-reward")
            const originalSettlement = additionalReward.settleAdditionalRewardsSync
            additionalReward.settleAdditionalRewardsSync = additionalSettlementOverride
            restoreAdditionalSettlement = () => {
                additionalReward.settleAdditionalRewardsSync = originalSettlement
            }
        }
        const staminaHealTimeTracker = createStaminaHealTimeTracker(
            getPlayerSync(playerId).staminaHealTime,
        )
        app = createSingleBattleApp()
        await app.ready()
        const requestRunner = createRequestSqlRunner(app, counter, measurementState, {
            getTimeOffset,
            readStaminaHealTime: () => getPlayerSync(playerId).staminaHealTime,
            staminaHealTimeTracker,
        })
        result = await operation({
            app,
            db: getDb(),
            playerId,
            ...requestRunner,
            makeAwakeEligible: () => fixture.makeAwakeEligible(playerId),
            insertActiveQuest: quest => insertActiveQuest(playerId, quest),
            clearActiveQuest: () => clearPublishedActiveQuest(playerId),
            createActiveQuest: fixture.createActiveQuest,
            finishPayload: fixture.finishPayload,
            snapshotState: options => fixture.snapshotSettlementState(playerId, {
                ...options,
                staminaHealTimeTracker,
            }),
            getPlayer: () => getPlayerSync(playerId),
            getItem: itemId => getPlayerItemSync(playerId, itemId) ?? 0,
            setItem: (itemId, amount) => setPlayerItemSync(playerId, itemId, amount),
            updatePlayer: values => updatePlayerSync({ id: playerId, ...values }),
        })
    } catch (error) {
        primaryError = error
    }

    const cleanupErrors = []
    for (const cleanup of [
        async () => { if (app) await app.close() },
        () => restoreAdditionalSettlement(),
        () => { for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId] },
        () => closeDatabase(),
        () => restoreContent(),
        () => setServerTimeOffset(originalTimeOffset),
        () => fs.rmSync(directory, { recursive: true, force: true }),
        () => Object.assign(console, originalConsole),
    ]) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError) throw primaryError
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "harness cleanup failed")
    return result
}

module.exports = {
    AWAKE_CHARACTER_ID: fixture.AWAKE_CHARACTER_ID,
    ENTRY_CATEGORY: fixture.ENTRY_CATEGORY,
    ENTRY_QUEST_ID: fixture.ENTRY_QUEST_ID,
    MAIN_CATEGORY: fixture.MAIN_CATEGORY,
    MAIN_QUEST_ID: fixture.MAIN_QUEST_ID,
    VIEWER_ID: fixture.VIEWER_ID,
    createActiveQuest: fixture.createActiveQuest,
    finishPayload: fixture.finishPayload,
    stableActiveQuest: fixture.stableActiveQuest,
    withSingleBattleHarness,
}
