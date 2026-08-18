"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "non-multi-mixed-scenarios-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let app = null
let data = null
let restoreContentSnapshot = () => {}
let restoreTime = () => {}
let cleaned = false

function restoreEnvironment() {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
async function cleanup() {
    if (cleaned) return
    cleaned = true
    const errors = []
    for (const action of [
        async () => { if (app) await app.close() },
        () => restoreActiveQuests(activeQuestsFixture.initial),
        () => data?.closeDatabase(),
        () => restoreContentSnapshot(),
        () => restoreTime(),
        () => fs.rmSync(databaseDirectory, { recursive: true, force: true }),
        restoreEnvironment,
    ]) {
        try { await action() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "scenario test cleanup failed")
}
process.once("exit", () => {
    if (cleaned) return
    try { restoreActiveQuests(activeQuestsFixture.initial) } catch {}
    try { data?.closeDatabase() } catch {}
    try { restoreContentSnapshot() } catch {}
    try { restoreTime() } catch {}
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    restoreEnvironment()
})
test.after(cleanup)
data = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
const { insertDeviceBindingSync } = require("../../src/data/domains/session")
const { SessionType } = require("../../src/data/types")
const cnLoadRoutes = require("../../src/routes/cn/load").default
const { registerCnMsgpackOnSend } = require("../../src/routes/cn/msgpack")
const cnToolRoutes = require("../../src/routes/cn/tool").default
const missionRoutes = require("../../src/routes/api/mission").default
const singleBattleRoutes = require("../../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")
const originalTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(originalTimeOffset)
const {
    installBundledGameplaySnapshot,
} = require("../helpers/install-bundled-gameplay-snapshot.cjs")
const { seedNonMultiMixedFixture } = require("./non_multi_mixed_fixture.cjs")
const {
    createNonMultiMixedHttpHarness,
} = require("./non_multi_mixed_http.cjs")
const { executeScenario } = require("./non_multi_mixed_scenarios.cjs")
const {
    createActiveQuestSentinel,
    prepareSingleBattleIdentity,
} = require("./non_multi_mixed_battle.cjs")
const {
    prepareActiveQuests,
    restoreActiveQuests,
} = require("./non_multi_mixed_active_quests.cjs")
const {
    projectNonMultiMixedOwnerState,
    snapshotNonMultiMixedOwnerState,
} = require("./non_multi_mixed_state_snapshot.cjs")
const activeQuestsFixture = prepareActiveQuests({ createSentinel: createActiveQuestSentinel })
const FIXED_SERVER_TIME = "2024-08-14T12:00:00.000Z"
function assertOtherOwnersUnchanged(before, after, targetIdentity) {
    assert.deepEqual(
        projectNonMultiMixedOwnerState(after, targetIdentity),
        projectNonMultiMixedOwnerState(before, targetIdentity),
    )
}
function inspectAuthIdentity(db, identity) {
    const binding = db.prepare(`
        SELECT device_id, account_id FROM device_bindings WHERE device_id = ?
    `).get(identity.deviceId)
    const viewerSessions = db.prepare(`
        SELECT token, account_id, type
        FROM sessions WHERE account_id = ? AND type = ? ORDER BY token
    `).all(identity.accountId, SessionType.VIEWER)
    return { binding, viewerSessions }
}
test("auth, load, mission-progress, and single-battle use isolated real CN HTTP journeys", async () => {
    setServerTimeOffset(Date.parse(FIXED_SERVER_TIME) - Date.now())
    restoreContentSnapshot = installBundledGameplaySnapshot({
        additionalTableNames: ["event_item_shop.json", "event_item_shop_id_map.json"],
    })
    data.initializeDatabase()
    const db = getDb()
    const pool = seedNonMultiMixedFixture({
        getDb,
        insertAccountSync,
        insertDefaultPlayerSync,
        insertDeviceBindingSync,
    }, {
        independentSaves: 7,
        activeIdentities: 7,
    })
    assert.equal(pool.identities.length, 7)
    assert.equal(pool.activeIdentities.length, 7)

    let multiRecoveryInspections = 0
    app = await createNonMultiMixedHttpHarness({
        registerMsgpackOnSend: registerCnMsgpackOnSend,
        routePlugins: [
            { plugin: cnToolRoutes, prefix: "/api/index.php/tool" },
            {
                plugin: cnLoadRoutes,
                prefix: "/api/index.php",
                options: {
                    assetProvider: { mode: "client-owned" },
                    multiMode: "client",
                    multiRecoveryVerifier: {
                        async inspect() {
                            multiRecoveryInspections++
                            throw new Error("non-multi load attempted multi recovery")
                        },
                    },
                },
            },
            { plugin: missionRoutes, prefix: "/api/index.php/mission" },
            { plugin: singleBattleRoutes, prefix: "/api/index.php/single_battle_quest" },
        ],
    })
    const byEntry = Object.fromEntries(pool.identities.map(identity => [identity.entryName, identity]))
    prepareSingleBattleIdentity(db, byEntry["single-battle"])
    let snapshotSingleBattleCalls = 0
    const context = {
        inspectAuthIdentity: identity => inspectAuthIdentity(db, identity),
        prepareSingleBattleIdentity: identity => prepareSingleBattleIdentity(db, identity),
        singleBattlePeer: byEntry.auth,
        snapshotSingleBattleState: () => {
            snapshotSingleBattleCalls++
            return {
                db: snapshotNonMultiMixedOwnerState(db),
                memory: structuredClone(activeQuests),
            }
        },
        getMultiRecoveryInspections: () => multiRecoveryInspections,
    }

    assert.deepEqual(
        db.prepare(`
            SELECT id FROM players_characters
            WHERE player_id = ? ORDER BY id
        `).all(byEntry["single-battle"].playerId),
        [{ id: 1 }],
    )
    assert.equal(
        db.prepare(`
            SELECT character_id_1 FROM players_parties
            WHERE player_id = ? AND slot = 2 AND group_id = 1 AND category = 1
        `).get(byEntry["single-battle"].playerId)?.character_id_1,
        1,
    )

    let before = snapshotNonMultiMixedOwnerState(db)
    const authPlayerBefore = db.prepare("SELECT * FROM players WHERE id = ?")
        .get(byEntry.auth.playerId)
    const auth = await executeScenario(app, byEntry.auth, context)
    let after = snapshotNonMultiMixedOwnerState(db)
    assert.deepEqual(auth, {
        entry: "auth",
        adapter: "fastify-route:/api/index.php/tool/signup",
        statusCode: 200,
        resultCode: 1,
        newAccount: 0,
        deviceBindingPreserved: true,
        accountPreserved: true,
        viewerSessionCount: 1,
    })
    assertOtherOwnersUnchanged(before, after, byEntry.auth)
    assert.deepEqual(
        db.prepare("SELECT * FROM players WHERE id = ?").get(byEntry.auth.playerId),
        authPlayerBefore,
    )
    const authSessions = db.prepare("SELECT * FROM sessions WHERE account_id = ?")
        .all(byEntry.auth.accountId)
    assert.equal(authSessions.length, 1)
    assert.equal(authSessions[0].token, String(byEntry.auth.viewerId))

    before = after
    const load = await executeScenario(app, byEntry.load, context)
    after = snapshotNonMultiMixedOwnerState(db)
    assert.deepEqual(load, {
        entry: "load",
        adapter: "fastify-route:/api/index.php/load",
        statusCode: 200,
        resultCode: 1,
        responseViewerMatchesAccount: true,
        assetUpdate: false,
        availableAssetVersion: "1.4.54",
        characterCount: 1,
        equipmentCount: 0,
        itemCount: 0,
        unfinishedQuestCount: 0,
        unfinishedMultiQuestCount: 0,
    })
    assert.equal(multiRecoveryInspections, 0)
    assertOtherOwnersUnchanged(before, after, byEntry.load)

    before = after
    const mission = await executeScenario(app, byEntry["mission-progress"], context)
    after = snapshotNonMultiMixedOwnerState(db)
    assert.equal(mission.entry, "mission-progress")
    assert.equal(mission.adapter, "fastify-route:/api/index.php/mission/get_mission_progress")
    assert.equal(mission.statusCode, 200)
    assert.equal(mission.resultCode, 1)
    assert.equal(mission.responseViewerMatchesIdentity, true)
    assert.ok(mission.missionProgressCount > 0)
    assert.match(mission.missionProgressSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(mission).sort(), [
        "adapter",
        "entry",
        "missionProgressCount",
        "missionProgressSha256",
        "responseViewerMatchesIdentity",
        "resultCode",
        "statusCode",
    ])
    assert.doesNotThrow(() => JSON.stringify(mission))
    assertOtherOwnersUnchanged(before, after, byEntry["mission-progress"])

    before = after
    const singleBattle = await executeScenario(app, byEntry["single-battle"], context)
    after = snapshotNonMultiMixedOwnerState(db)
    assert.deepEqual(singleBattle, {
        entry: "single-battle",
        adapter: "fastify-route:/api/index.php/single_battle_quest/start->finish",
        statusCode: 200,
        resultCode: 1,
        viewerId: byEntry["single-battle"].viewerId,
        category: 1,
        questId: 1001002,
        playId: "non-multi-mixed-single-battle",
        isMulti: "single",
        start: {
            activeQuest: {
                playId: "non-multi-mixed-single-battle",
                questId: 1001002,
                category: 1,
                isMulti: false,
                continueCount: 0,
            },
            stamina: { before: 100, after: 94, spent: 6 },
        },
        finish: {
            activeQuest: null,
            stamina: { before: 94, after: 94, delta: 0 },
            reward: { rewardMana: 20, fieldMana: 11, rewardPoolExp: 13 },
            missionProgressChanged: true,
        },
        repeatedFinishRejected: true,
        negativeLifecycle: {
            crossOwnerFinishRejected: true,
            wrongPlayIdFinishRejected: true,
            duplicateStartRejected: true,
        },
        multiRecoveryInspections: 0,
    })
    assert.deepEqual(activeQuests[activeQuestsFixture.sentinelKey], createActiveQuestSentinel())
    assert.equal(snapshotSingleBattleCalls, 8)
    assertOtherOwnersUnchanged(before, after, byEntry["single-battle"])

    // Unsupported dispatcher entries stay fail-closed; do not emit meaningless HTTP requests.
    for (const entry of ["shop", "gacha", "mail", "unknown"]) {
        const identity = entry === "unknown"
            ? { ...byEntry.auth, entryName: entry }
            : byEntry[entry]
        await assert.rejects(
            () => executeScenario(app, identity, context),
            new RegExp(`unsupported non-multi mixed scenario: ${entry}`),
        )
    }
})
