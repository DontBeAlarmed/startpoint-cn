const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const questEntryCosts = require(path.join(projectRoot, "assets/quest_entry_costs.json"))

let lifecycle = {}
try {
    lifecycle = require("../src/lib/quest/entry-lifecycle")
} catch {
    // The RED run intentionally reaches this branch before the module exists.
}

assert.equal(typeof lifecycle.runAbortEntryTransaction, "function")
assert.equal(typeof lifecycle.restoreActiveQuestFromStorage, "function")

function createActiveQuest(overrides = {}) {
    return {
        playerId: 7,
        playId: "ticket-play-1",
        questId: 200076009,
        category: 7,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        roomNumber: null,
        entryItemId: 10000072,
        entryItemCount: 1,
        eventId: null,
        continueCount: 0,
        ...overrides,
    }
}

function createAbortInput(overrides = {}) {
    return {
        playerId: 7,
        playId: "ticket-play-1",
        questId: 200076009,
        category: 7,
        ...overrides,
    }
}

function createFixture({
    activeQuest = createActiveQuest(),
    initialMemoryActiveQuest,
    itemCount = 0,
    failDuringCommit = false,
    entryCost,
} = {}) {
    let databaseState = { activeQuest, itemCount }
    let memoryActiveQuest = initialMemoryActiveQuest === undefined
        ? activeQuest ? { ...activeQuest } : null
        : initialMemoryActiveQuest ? { ...initialMemoryActiveQuest } : null
    let transactionActive = false
    let activeReads = 0
    const writes = []

    const dependencies = {
        transaction(operation) {
            const snapshot = structuredClone(databaseState)
            transactionActive = true
            try {
                const result = operation()
                if (failDuringCommit) throw new Error("simulated abort commit failure")
                return result
            } catch (error) {
                databaseState = snapshot
                throw error
            } finally {
                transactionActive = false
            }
        },
        getActiveQuest() {
            assert.equal(transactionActive, true)
            activeReads++
            return databaseState.activeQuest
        },
        getItemCount() {
            assert.equal(transactionActive, true)
            return databaseState.itemCount
        },
        setItemCount(_playerId, _itemId, amount) {
            assert.equal(transactionActive, true)
            writes.push("item")
            databaseState.itemCount = amount
        },
        deleteActiveQuest() {
            assert.equal(transactionActive, true)
            writes.push("dbActiveQuest")
            databaseState.activeQuest = null
        },
        clearActiveQuest() {
            assert.equal(transactionActive, false)
            writes.push("memoryActiveQuest")
            memoryActiveQuest = null
        },
        getEntryCost(category, questId) {
            return entryCost ?? questEntryCosts[`${category}_${questId}`]
        },
    }

    return {
        dependencies,
        getActiveReads: () => activeReads,
        getState: () => ({ ...databaseState, memoryActiveQuest }),
        writes,
    }
}

{
    const fixture = createFixture()
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)

    assert.equal(result.cancelled, true)
    assert.deepEqual(result.resolvedIdentity, {
        playId: "ticket-play-1",
        questId: 200076009,
        category: 7,
    })
    assert.equal(result.observedActiveQuest.playId, "ticket-play-1")
    assert.equal(fixture.getActiveReads(), 1)
    assert.deepEqual(result.itemList, { 10000072: 1 })
    assert.equal(fixture.getState().itemCount, 1)
    assert.equal(fixture.getState().activeQuest, null)
    assert.equal(fixture.getState().memoryActiveQuest, null)
    assert.deepEqual(fixture.writes, ["item", "dbActiveQuest", "memoryActiveQuest"])

    const repeated = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.equal(repeated.cancelled, false)
    assert.deepEqual(repeated.itemList, {})
    assert.equal(fixture.getState().itemCount, 1)
    assert.deepEqual(fixture.writes, [
        "item",
        "dbActiveQuest",
        "memoryActiveQuest",
        "memoryActiveQuest",
    ])
}

{
    const fixture = createFixture()
    const result = lifecycle.runAbortEntryTransaction(createAbortInput({
        playId: null,
        questId: null,
        category: null,
    }), fixture.dependencies)

    assert.equal(result.cancelled, true)
    assert.deepEqual(result.resolvedIdentity, {
        playId: "ticket-play-1",
        questId: 200076009,
        category: 7,
    })
    assert.equal(result.observedActiveQuest.playId, "ticket-play-1")
    assert.equal(fixture.getActiveReads(), 1)
}

{
    const fixture = createFixture({
        activeQuest: null,
        initialMemoryActiveQuest: createActiveQuest(),
        itemCount: 4,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput({
        playId: null,
        questId: null,
        category: null,
    }), fixture.dependencies)

    assert.deepEqual(result, {
        cancelled: false,
        activeQuest: null,
        observedActiveQuest: null,
        resolvedIdentity: { playId: "", questId: 0, category: 0 },
        itemList: {},
        refundedStamina: 0,
    })
    assert.equal(fixture.getActiveReads(), 1)
    assert.equal(fixture.getState().memoryActiveQuest, null)
    assert.deepEqual(fixture.writes, ["memoryActiveQuest"])
}

{
    const fixture = createFixture({
        activeQuest: null,
        initialMemoryActiveQuest: createActiveQuest(),
        failDuringCommit: true,
    })
    assert.throws(
        () => lifecycle.runAbortEntryTransaction(createAbortInput({
            playId: null,
            questId: null,
            category: null,
        }), fixture.dependencies),
        /simulated abort commit failure/,
    )
    assert.equal(fixture.getState().memoryActiveQuest.playId, "ticket-play-1")
    assert.deepEqual(fixture.writes, [])
}

{
    const fixture = createFixture()
    const result = lifecycle.runAbortEntryTransaction(createAbortInput({
        category: 0,
    }), fixture.dependencies)

    assert.equal(result.cancelled, false)
    assert.equal(result.resolvedIdentity.category, 0)
    assert.equal(result.observedActiveQuest.category, 7)
    assert.equal(fixture.getState().activeQuest.playId, "ticket-play-1")
    assert.equal(fixture.getState().memoryActiveQuest.playId, "ticket-play-1")
    assert.equal(fixture.getActiveReads(), 1)
    assert.deepEqual(fixture.writes, [])
}

{
    const fixture = createFixture({ failDuringCommit: true })
    assert.throws(
        () => lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies),
        /simulated abort commit failure/,
    )
    assert.equal(fixture.getState().itemCount, 0)
    assert.equal(fixture.getState().activeQuest.playId, "ticket-play-1")
    assert.equal(fixture.getState().memoryActiveQuest.playId, "ticket-play-1")
    assert.deepEqual(fixture.writes, ["item", "dbActiveQuest"])
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({ entryItemId: null, entryItemCount: null }),
        itemCount: 9,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.deepEqual(result.itemList, {})
    assert.equal(fixture.getState().itemCount, 9)
    assert.equal(fixture.getState().activeQuest, null)
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({ entryItemCount: null }),
        itemCount: 2,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.deepEqual(result.itemList, { 10000072: 3 })
    assert.equal(fixture.getState().itemCount, 3)
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({ entryItemId: 500000, entryItemCount: null }),
        itemCount: 2,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.deepEqual(result.itemList, {})
    assert.equal(fixture.getState().itemCount, 2)
    assert.equal(fixture.getState().activeQuest, null)
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({ entryItemCount: 0 }),
        itemCount: 2,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.deepEqual(result.itemList, {})
    assert.equal(fixture.getState().itemCount, 2)
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({
            playId: "new-play",
            questId: 200071009,
            entryItemId: 10000049,
        }),
        itemCount: 4,
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.equal(result.cancelled, false)
    assert.deepEqual(result.itemList, {})
    assert.equal(fixture.getState().itemCount, 4)
    assert.equal(fixture.getState().activeQuest.playId, "new-play")
    assert.equal(fixture.getState().memoryActiveQuest.playId, "new-play")
    assert.deepEqual(fixture.writes, [])
}

{
    const fixture = createFixture({
        activeQuest: createActiveQuest({ entryItemCount: null }),
        itemCount: 2,
        entryCost: { itemId: 10000072, itemCount: 2, stamina: 30 },
    })
    const result = lifecycle.runAbortEntryTransaction(createAbortInput(), fixture.dependencies)
    assert.equal(result.cancelled, true)
    assert.deepEqual(result.itemList, {})
    assert.equal(fixture.getState().itemCount, 2)
}

{
    let restored = null
    const writes = []
    const legacy = createActiveQuest({ entryItemCount: null })
    const result = lifecycle.restoreActiveQuestFromStorage(7, legacy, {
        getEntryCost(category, questId) {
            return questEntryCosts[`${category}_${questId}`]
        },
        persistEntryItemCount(_playerId, itemCount) {
            writes.push(["persist", itemCount])
        },
        publishActiveQuest(_playerId, activeQuest) {
            writes.push(["publish", activeQuest.entryItemCount])
            restored = activeQuest
        },
    })

    assert.equal(result.entryItemCount, 1)
    assert.equal(restored.entryItemCount, 1)
    assert.equal(restored.playId, "ticket-play-1")
    assert.deepEqual(writes, [["persist", 1], ["publish", 1]])
}

const singleRouteSource = fs.readFileSync(
    path.join(projectRoot, "src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const finishBlock = singleRouteSource.slice(
    singleRouteSource.indexOf('fastify.post("/finish"'),
    singleRouteSource.indexOf('fastify.post("/abort"'),
)
const continueBlock = singleRouteSource.slice(
    singleRouteSource.indexOf('fastify.post("/play_continue"'),
)
for (const [name, block] of [["finish", finishBlock], ["continue", continueBlock]]) {
    assert.doesNotMatch(block, /(?:set|update)PlayerItemSync\s*\(/, `${name} must not deduct the entry item again`)
    assert.doesNotMatch(block, /runStartEntryTransaction\s*\(/, `${name} must not rerun start entry costs`)
}

const loadSource = fs.readFileSync(path.join(projectRoot, "src/routes/cn/load.ts"), "utf8")
assert.match(
    loadSource,
    /restoreActiveQuestFromStorage\s*\(/,
    "CN load must restore persisted active quests into memory",
)
assert.match(
    loadSource,
    /runAbortActiveQuestTransaction\s*\(/,
    "CN load must use cancellation semantics when an unfinished multi room is invalid",
)

assert.match(singleRouteSource, /entryItemCount:/, "quest start must persist the prepaid item count")
assert.match(
    singleRouteSource,
    /["']item_list["']\s*:\s*abortResult\.itemList/,
    "quest abort must return the absolute refunded item count",
)

const Database = require("better-sqlite3")
const transactionDb = new Database(":memory:")
transactionDb.exec(`
    CREATE TABLE players_active_quests (
        player_id INTEGER PRIMARY KEY,
        play_id TEXT NOT NULL,
        quest_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        entry_item_id INTEGER,
        entry_item_count INTEGER
    );
    CREATE TABLE players_items (
        player_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (player_id, id)
    );
    INSERT INTO players_active_quests VALUES
        (7, 'ticket-play-1', 200076009, 7, 10000072, 1);
    INSERT INTO players_items VALUES (7, 10000072, 0);
    CREATE TRIGGER reject_active_delete
    BEFORE DELETE ON players_active_quests
    BEGIN
        SELECT RAISE(ABORT, 'simulated active delete failure');
    END;
`)
let transactionMemoryActive = createActiveQuest()
const transactionDependencies = {
    transaction(operation) {
        return transactionDb.transaction(operation)()
    },
    getActiveQuest(playerId) {
        const row = transactionDb.prepare(`
            SELECT * FROM players_active_quests WHERE player_id = ?
        `).get(playerId)
        return row ? createActiveQuest({
            playId: row.play_id,
            questId: row.quest_id,
            category: row.category,
            entryItemId: row.entry_item_id,
            entryItemCount: row.entry_item_count,
        }) : null
    },
    getItemCount(playerId, itemId) {
        return transactionDb.prepare(`
            SELECT amount FROM players_items WHERE player_id = ? AND id = ?
        `).get(playerId, itemId)?.amount ?? null
    },
    setItemCount(playerId, itemId, amount) {
        transactionDb.prepare(`
            UPDATE players_items SET amount = ? WHERE player_id = ? AND id = ?
        `).run(amount, playerId, itemId)
    },
    deleteActiveQuest(playerId) {
        transactionDb.prepare(`DELETE FROM players_active_quests WHERE player_id = ?`).run(playerId)
    },
    clearActiveQuest() {
        transactionMemoryActive = null
    },
    getEntryCost(category, questId) {
        return questEntryCosts[`${category}_${questId}`]
    },
}

assert.throws(
    () => lifecycle.runAbortEntryTransaction(createAbortInput(), transactionDependencies),
    /simulated active delete failure/,
)
assert.equal(transactionDb.prepare(`SELECT amount FROM players_items`).get().amount, 0)
assert.equal(transactionDb.prepare(`SELECT COUNT(*) AS count FROM players_active_quests`).get().count, 1)
assert.equal(transactionMemoryActive.playId, "ticket-play-1")

transactionDb.exec(`DROP TRIGGER reject_active_delete`)
const committedAbort = lifecycle.runAbortEntryTransaction(createAbortInput(), transactionDependencies)
assert.equal(committedAbort.cancelled, true)
assert.deepEqual(committedAbort.itemList, { 10000072: 1 })
assert.equal(transactionDb.prepare(`SELECT amount FROM players_items`).get().amount, 1)
assert.equal(transactionDb.prepare(`SELECT COUNT(*) AS count FROM players_active_quests`).get().count, 0)
assert.equal(transactionMemoryActive, null)
transactionDb.close()

const legacyDb = new Database(":memory:")
legacyDb.exec(`
    CREATE TABLE players_active_quests (
        player_id INTEGER PRIMARY KEY,
        play_id TEXT NOT NULL,
        quest_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        use_boss_boost_point INTEGER NOT NULL DEFAULT 0,
        use_boost_point INTEGER NOT NULL DEFAULT 0,
        is_auto_start_mode INTEGER NOT NULL DEFAULT 0,
        is_multi INTEGER NOT NULL DEFAULT 0,
        room_number TEXT,
        entry_item_id INTEGER,
        event_id INTEGER,
        continue_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO players_active_quests (
        player_id, play_id, quest_id, category, entry_item_id
    ) VALUES (7, 'legacy-play', 200076009, 7, 10000072);
`)

let activeQuestStorage = {}
try {
    activeQuestStorage = require("../src/lib/quest/active-quest-persistence")
} catch {
    // The RED run intentionally reaches this branch before the migration helper exists.
}
assert.equal(typeof activeQuestStorage.ensureActiveQuestEntryItemCountStorageSync, "function")
activeQuestStorage.ensureActiveQuestEntryItemCountStorageSync(legacyDb)
assert.ok(
    legacyDb.prepare("PRAGMA table_info(players_active_quests)").all()
        .some(column => column.name === "entry_item_count"),
)
activeQuestStorage.ensureActiveQuestBattleSessionIdStorageSync(legacyDb)
activeQuestStorage.ensureActiveQuestCoordinatorOriginStorageSync(legacyDb)
activeQuestStorage.ensureActiveQuestResourceCostStorageSync(legacyDb)

const dbModulePath = require.resolve("../src/data/db")
require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: { getDb: () => legacyDb },
}
delete require.cache[require.resolve("../src/data/domains/quest_active")]
const questActive = require("../src/data/domains/quest_active")

assert.equal(questActive.getPlayerActiveQuestSync(7).entryItemCount, null)
questActive.insertPlayerActiveQuestSync(8, createActiveQuest({
    playerId: 8,
    playId: "persisted-play",
    entryItemCount: 2,
}))
assert.equal(questActive.getPlayerActiveQuestSync(8).entryItemCount, 2)
questActive.updatePlayerActiveQuestEntryItemCountSync(7, 1)
assert.equal(questActive.getPlayerActiveQuestSync(7).entryItemCount, 1)
legacyDb.close()

console.log("quest entry lifecycle tests passed")
