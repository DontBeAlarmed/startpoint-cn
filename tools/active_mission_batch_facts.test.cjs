"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const BetterSqlite3 = require("better-sqlite3")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-batch-facts-"))
const data = require("../src/data")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")
const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const { createSqlCounter } = require("./perf/mission_settlement_sql.cjs")
const { selectActiveMissionFixture } = require("./perf/active-mission/fixture.cjs")

const officialMissions = require("../assets/mission_active.json")
const officialRewards = require("../assets/mission_active_reward.json")
const characterIds = [1, ...Object.keys(require("../assets/character.json"))
    .map(Number)
    .filter(characterId => characterId !== 1)]
    .slice(0, 81)

function buildMissionOverrides() {
    const missions = structuredClone(officialMissions)
    const rewards = structuredClone(officialRewards)
    const template = officialMissions[20003][0]
    for (const [index, characterId] of characterIds.entries()) {
        const missionId = 99000 + index
        const row = structuredClone(template)
        row[32] = "3"
        row[43] = String(characterId)
        missions[missionId] = [row]
        rewards[missionId] = structuredClone(officialRewards[20003])
    }
    return {
        "mission_active.json": missions,
        "mission_active_reward.json": rewards,
    }
}

const measurement = { active: false }
const sqlCounter = createSqlCounter()
const restoreContent = installBundledGameplaySnapshot({
    tableOverrides: buildMissionOverrides(),
})
let db

function cleanup() {
    try { data.closeDatabase() } catch { /* already closed */ }
    restoreContent()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
}

process.once("exit", cleanup)

data.initializeDatabase({
    paths: resolveRuntimeDataPaths({ DATA_DIR: databaseDirectory }),
    databaseFactory: databasePath => new BetterSqlite3(databasePath, {
        verbose: sql => {
            if (measurement.active && /^\s*SELECT\b/i.test(sql)) sqlCounter.observe(sql)
        },
    }),
})
db = require("../src/data/db").getDb()

const {
    getContentSnapshot,
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    getPlayerCharacterGrowthFactsByIdsSync,
    getPlayerCharacterManaNodesByIdsSync,
} = require("../src/data/domains/character")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { getPlayerSync } = require("../src/data/domains/player")
const {
    createActiveBattleFactContext,
} = require("../src/lib/mission/active-battle-fact-context")
const { getActiveMissionPlan } = require("../src/lib/mission/active-plan")
const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")
const { reconcileActiveMissionFacts } = require("../src/lib/mission/active-reconciliation")

function retainCharacters(playerId, count) {
    const ownedIds = db.prepare(`
        SELECT id FROM players_characters
        WHERE player_id = ?
        ORDER BY id
    `).all(playerId).map(row => row.id)
    const retainedIds = ownedIds.slice(0, count)
    assert.equal(retainedIds.length, count)
    const placeholders = retainedIds.map(() => "?").join(", ")
    for (const table of [
        "players_characters_bond_tokens",
        "players_characters_mana_nodes",
        "players_character_quest_clears",
        "players_characters",
    ]) {
        db.prepare(`
            DELETE FROM ${table}
            WHERE player_id = ? AND character_id NOT IN (${placeholders})
        `.replace("character_id", table === "players_characters" ? "id" : "character_id"))
            .run(playerId, ...retainedIds)
    }
    return retainedIds
}

function measure(operation) {
    sqlCounter.reset()
    measurement.active = true
    try {
        operation()
    } finally {
        measurement.active = false
    }
    return sqlCounter.snapshot()
}

function createFinishContext(playerId, ownedCharacterIds) {
    const characters = ownedCharacterIds.map(id => ({ id }))
    const unisonCharacters = ownedCharacterIds.map(() => null)
    return {
        playerId,
        questCategory: 1,
        questId: 1001001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: {
            characters,
            unison_characters: unisonCharacters,
        },
        statistics: {
            clear_phase: 1,
            party: {
                characters,
                unison_characters: unisonCharacters,
            },
            zones: [],
        },
        player: getPlayerSync(playerId),
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: false,
        isMultiHost: false,
    }
}

const profiles = [
    { fixture: "new-account", characterCount: 1 },
    { fixture: "normal-progress", characterCount: 6 },
    { fixture: "high-completion-volume", characterCount: 81 },
]
const measurements = []
for (const profile of profiles) {
    const playerId = selectActiveMissionFixture(profile.fixture).create()
    const ownedCharacterIds = retainCharacters(playerId, profile.characterCount)
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players_characters WHERE player_id = ?")
            .get(playerId).count,
        profile.characterCount,
    )

    const repository = getContentSnapshot().repository
    const reconcileSql = measure(() => reconcileActiveMissionFacts({
        playerId,
        repository,
        now: Date.parse("2024-08-14T12:00:00.000Z"),
    }))
    const finishContext = createFinishContext(playerId, ownedCharacterIds)
    const activeContext = createActiveBattleFactContext(
        finishContext,
        getActiveMissionPlan(repository),
        repository,
    )
    assert.deepEqual(
        activeContext.targetCharacterIds,
        ownedCharacterIds,
        `${profile.characterCount} character fixture must hit every synthetic target`,
    )
    const battleFactSql = measure(() => recordMissionBattleFacts(
        finishContext,
        new Date("2024-08-14T12:00:00.000Z"),
    ))
    measurements.push({
        characterCount: profile.characterCount,
        characterClearReads: reconcileSql.byTable.players_character_quest_clears?.reads ?? 0,
        counterReads: reconcileSql.byTable.players_active_mission_counters?.reads ?? 0,
        battleFactSqlReads: battleFactSql.selectStatements,
        characterGrowthReads: battleFactSql.byTable.players_characters?.reads ?? 0,
        characterManaNodeReads: battleFactSql.byTable.players_characters_mana_nodes?.reads ?? 0,
    })
}

assert.deepEqual(measurements, [1, 6, 81].map(characterCount => ({
    characterCount,
    characterClearReads: 0,
    counterReads: 1,
    battleFactSqlReads: 2,
    characterGrowthReads: 1,
    characterManaNodeReads: 1,
})))

const failedPlayerId = db.prepare("SELECT id FROM players ORDER BY id LIMIT 1").get().id
const failedCharacterIds = db.prepare(`
    SELECT id FROM players_characters WHERE player_id = ? ORDER BY id
`).all(failedPlayerId).map(row => row.id)
const failedBattleSql = measure(() => recordMissionBattleFacts({
    ...createFinishContext(failedPlayerId, failedCharacterIds),
    questAccomplished: false,
}, new Date("2024-08-14T12:00:00.000Z")))
assert.equal(
    failedBattleSql.byTable.players_characters?.reads ?? 0,
    0,
    "failed battle must not load Active Mission character growth facts",
)
assert.equal(
    failedBattleSql.byTable.players_characters_mana_nodes?.reads ?? 0,
    0,
    "failed battle must not load Active Mission character mana nodes",
)

const originalSnapshot = productionContentSnapshotProvider.snapshot
const originalRepository = originalSnapshot.repository
const alternateRepository = {
    info: () => originalRepository.info(),
    table: tableName => originalRepository.table(tableName),
}
productionContentSnapshotProvider.snapshot = {
    ...originalSnapshot,
    repository: alternateRepository,
}
try {
    const playerId = db.prepare("SELECT id FROM players ORDER BY id LIMIT 1").get().id
    const ownedCharacterIds = db.prepare(`
        SELECT id FROM players_characters WHERE player_id = ? ORDER BY id
    `).all(playerId).map(row => row.id)
    const context = createActiveBattleFactContext(
        createFinishContext(playerId, ownedCharacterIds),
        getActiveMissionPlan(originalRepository),
        originalRepository,
    )
    assert.equal(context.repository, originalRepository)
} finally {
    productionContentSnapshotProvider.snapshot = originalSnapshot
}

const validationPlayerId = db.prepare("SELECT id FROM players ORDER BY id LIMIT 1 OFFSET 1").get().id
const validationCharacterIds = db.prepare(`
    SELECT id FROM players_characters
    WHERE player_id = ?
    ORDER BY id
    LIMIT 2
`).all(validationPlayerId).map(row => row.id)
const [firstCharacterId, secondCharacterId] = validationCharacterIds
db.prepare("UPDATE players_characters SET exp = -10 WHERE player_id = ? AND id = ?")
    .run(validationPlayerId, firstCharacterId)
db.prepare("UPDATE players_characters SET exp = 123 WHERE player_id = ? AND id = ?")
    .run(validationPlayerId, secondCharacterId)
db.prepare(`
    INSERT INTO players_characters_mana_nodes (value, character_id, player_id)
    VALUES (111, ?, ?), (222, ?, ?)
`).run(firstCharacterId, validationPlayerId, firstCharacterId, validationPlayerId)

const emptyBatchSql = measure(() => {
    assert.deepEqual(getPlayerCharacterGrowthFactsByIdsSync(validationPlayerId, []), {})
    assert.deepEqual(getPlayerCharacterManaNodesByIdsSync(validationPlayerId, []), {})
})
assert.equal(emptyBatchSql.selectStatements, 0, "empty character fact batches must execute no SQL")
assert.deepEqual(
    getPlayerCharacterGrowthFactsByIdsSync(validationPlayerId, [
        secondCharacterId,
        firstCharacterId,
        secondCharacterId,
    ]),
    {
        [firstCharacterId]: { exp: -10 },
        [secondCharacterId]: { exp: 123 },
    },
)
assert.deepEqual(
    getPlayerCharacterManaNodesByIdsSync(validationPlayerId, [
        secondCharacterId,
        firstCharacterId,
        secondCharacterId,
    ]),
    { [firstCharacterId]: [111, 222] },
)
for (const invalidId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidBatchSql = measure(() => {
        assert.throws(
            () => getPlayerCharacterGrowthFactsByIdsSync(validationPlayerId, [firstCharacterId, invalidId]),
            /positive safe integers/,
        )
        assert.throws(
            () => getPlayerCharacterManaNodesByIdsSync(validationPlayerId, [firstCharacterId, invalidId]),
            /positive safe integers/,
        )
    })
    assert.equal(invalidBatchSql.selectStatements, 0, "invalid character IDs must be rejected before SQL")
}

db.prepare("INSERT OR IGNORE INTO players_active_mission_counters (player_id) VALUES (?)")
    .run(validationPlayerId)
db.prepare(`
    UPDATE players_active_mission_counters
    SET total_used_mana_count = -1,
        total_gacha_character_count = -2,
        total_equipment_equip_count = -3,
        total_unison_set_count = -4,
        total_party_character_set_count = -5,
        total_injected_exp_count = -6,
        total_gacha_campaign_count = -7,
        practice_quest_challenge_count = -8
    WHERE player_id = ?
`).run(validationPlayerId)
assert.deepEqual(getActiveMissionCountersSync(validationPlayerId), {
    totalUsedManaCount: 0,
    totalGachaCharacterCount: 0,
    totalEquipmentEquipCount: 0,
    totalUnisonSetCount: 0,
    totalPartyCharacterSetCount: 0,
    totalInjectedExpCount: 0,
    totalGachaCampaignCount: 0,
    practiceQuestChallengeCount: 0,
})

console.log(JSON.stringify(measurements))
cleanup()
process.removeListener("exit", cleanup)
