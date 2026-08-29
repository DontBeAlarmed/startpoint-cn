"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const {
    commitEntryResources,
    releaseEntryResources,
} = require("../src/lib/quest/entry-lifecycle")
const {
    DailyChallengePointExhaustedError,
    DailyChallengePointUnavailableError,
} = require("../src/lib/quest/daily-challenge")
const { runStartEntryTransaction } = require("../src/lib/quest/start-entry")
const { createRoom, disbandRoom, setRoomDisbandListener } = require("../src/multi/room/manager")

function createActiveQuest(overrides = {}) {
    return {
        playId: "resource-play",
        questId: 1001,
        category: 1,
        entryItemId: 500000,
        entryItemCount: 2,
        staminaCost: 8,
        dailyChallengePointId: 9001,
        continueCount: 0,
        ...overrides,
    }
}

function createResourceFixture({
    activeQuest = createActiveQuest(),
    player = { id: 7, stamina: 12, staminaHealTime: new Date(0), totalStaminaUsed: 100 },
    itemCount = 4,
    points = [{ id: 9001, point: 1, campaignList: [] }],
    failAfterWrite = false,
} = {}) {
    let state = structuredClone({ activeQuest, player, itemCount, points })
    let transactionActive = false
    let transactionDepth = 0
    const writes = []

    const snapshot = () => structuredClone(state)
    const dependencies = {
        transaction(operation) {
            const before = snapshot()
            transactionDepth++
            transactionActive = true
            try {
                const result = operation()
                if (failAfterWrite) throw new Error("simulated resource transaction failure")
                return result
            } catch (error) {
                state = before
                throw error
            } finally {
                transactionDepth--
                transactionActive = transactionDepth > 0
            }
        },
        assertInsideTransaction() {
            assert.equal(transactionActive, true)
        },
        getPlayer(playerId) {
            dependencies.assertInsideTransaction()
            assert.equal(playerId, 7)
            return structuredClone(state.player)
        },
        computeStamina(player) {
            return player.stamina + 3
        },
        updatePlayer(update) {
            dependencies.assertInsideTransaction()
            writes.push(["player", structuredClone(update)])
            state.player = { ...state.player, ...update }
        },
        getItemCount(playerId, itemId) {
            dependencies.assertInsideTransaction()
            assert.equal(playerId, 7)
            assert.equal(itemId, activeQuest.entryItemId)
            return state.itemCount
        },
        setItemCount(playerId, itemId, amount) {
            dependencies.assertInsideTransaction()
            writes.push(["item", itemId, amount])
            state.itemCount = amount
        },
        deleteActiveQuest(playerId) {
            dependencies.assertInsideTransaction()
            writes.push("activeQuest")
            state.activeQuest = null
        },
        refreshDailyChallengePoints(playerId) {
            dependencies.assertInsideTransaction()
            writes.push("refreshPoints")
        },
        getDailyChallengePointEntries(playerId) {
            dependencies.assertInsideTransaction()
            return structuredClone(state.points)
        },
        updateDailyChallengePoint(playerId, entryId, point) {
            dependencies.assertInsideTransaction()
            writes.push(["challengePoint", entryId, point])
            const entry = state.points.find(candidate => candidate.id === entryId)
            if (entry) entry.point = point
        },
    }

    return {
        dependencies,
        getActiveQuest: () => structuredClone(state.activeQuest),
        getPlayer: () => structuredClone(state.player),
        getItemCount: () => state.itemCount,
        getPoints: () => structuredClone(state.points),
        getWrites: () => structuredClone(writes),
    }
}

{
    const activeQuest = createActiveQuest({ staminaCost: undefined })
    let persisted
    const fixture = createResourceFixture({ activeQuest })
    const result = runStartEntryTransaction({
        playerId: 7,
        entryCost: { itemId: 500000, itemCount: 2, stamina: 8 },
        staminaCost: 8,
        partyId: 3,
        updatePartySlot: true,
        activeQuest,
        now: new Date("2026-08-29T00:00:00Z"),
    }, {
        transaction: operation => fixture.dependencies.transaction(operation),
        getPlayer: () => ({
            id: 7,
            stamina: 12,
            staminaHealTime: new Date(0),
            rankPoint: 1,
            totalStaminaUsed: 100,
            partySlot: 1,
        }),
        computeStamina: player => player.stamina + 3,
        getItemCount: () => 4,
        updateItemCount: (_playerId, _itemId, amount) => {
            fixture.dependencies.setItemCount(7, 500000, amount)
        },
        updatePlayer: update => fixture.dependencies.updatePlayer(update),
        persistActiveQuest: (_playerId, quest) => { persisted = structuredClone(quest) },
        publishActiveQuest: () => {},
    })

    assert.equal(result.afterStamina, 7)
    assert.equal(fixture.getItemCount(), 2)
    assert.equal(persisted.staminaCost, 8)
    assert.deepEqual(
        fixture.getWrites().filter(([target]) => target === "player"),
        [[
            "player",
            {
                id: 7,
                stamina: 7,
                staminaHealTime: new Date("2026-08-29T00:00:00Z"),
                partySlot: 3,
            },
        ]],
    )
}

{
    const fixture = createResourceFixture({
        points: [{
            id: 9001,
            point: 1,
            campaignList: [{ campaignId: 3001, additionalPoint: 2 }],
        }],
    })
    const result = fixture.dependencies.transaction(() => commitEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
    }, fixture.dependencies))

    assert.equal(result.staminaUsed, 8)
    assert.deepEqual(result.dailyChallengePointList, [{
        id: 9001,
        point: 0,
        campaign_list: [{ campaign_id: 3001, additional_point: 2 }],
    }])
    assert.deepEqual(fixture.getWrites(), [
        ["player", { id: 7, totalStaminaUsed: 108 }],
        "refreshPoints",
        ["challengePoint", 9001, 0],
    ])
    assert.equal(fixture.getItemCount(), 4)
    assert.notEqual(fixture.getActiveQuest(), null)
}

{
    const fixture = createResourceFixture({
        points: [{ id: 9001, point: 0, campaignList: [] }],
    })
    assert.throws(
        () => fixture.dependencies.transaction(() => commitEntryResources({
            playerId: 7,
            activeQuest: fixture.getActiveQuest(),
        }, fixture.dependencies)),
        DailyChallengePointExhaustedError,
    )
}

{
    const fixture = createResourceFixture({ points: [] })
    assert.throws(
        () => fixture.dependencies.transaction(() => commitEntryResources({
            playerId: 7,
            activeQuest: fixture.getActiveQuest(),
        }, fixture.dependencies)),
        DailyChallengePointUnavailableError,
    )
}

{
    const fixture = createResourceFixture()
    const result = fixture.dependencies.transaction(() => releaseEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
        now: new Date("2026-08-29T01:00:00Z"),
    }, fixture.dependencies))

    assert.equal(result.refundedStamina, 8)
    assert.deepEqual(result.itemList, { 500000: 6 })
    assert.deepEqual(fixture.getWrites(), [
        ["player", {
            id: 7,
            stamina: 23,
            staminaHealTime: new Date("2026-08-29T01:00:00Z"),
        }],
        ["item", 500000, 6],
        "activeQuest",
    ])
    assert.equal(fixture.getActiveQuest(), null)
}

{
    const fixture = createResourceFixture({
        activeQuest: createActiveQuest({ staminaCost: 10 }),
        player: {
            id: 7,
            stamina: 89,
            staminaHealTime: new Date(0),
            totalStaminaUsed: 100,
        },
    })
    const result = fixture.dependencies.transaction(() => releaseEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
        now: new Date("2026-08-29T01:00:00Z"),
    }, fixture.dependencies))

    assert.equal(result.afterStamina, 102, "natural recovery 92 plus refund 10 must remain 102")
    assert.equal(fixture.getPlayer().stamina, 102)
}

{
    const fixture = createResourceFixture({
        activeQuest: createActiveQuest({ staminaCost: 10 }),
        player: {
            id: 7,
            stamina: 995,
            staminaHealTime: new Date(0),
            totalStaminaUsed: 100,
        },
    })
    const result = fixture.dependencies.transaction(() => releaseEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
        now: new Date("2026-08-29T01:00:00Z"),
    }, fixture.dependencies))

    assert.equal(result.afterStamina, 999, "refunded stamina must never exceed the absolute cap")
    assert.equal(fixture.getPlayer().stamina, 999)
}

{
    const fixture = createResourceFixture({
        activeQuest: createActiveQuest({ staminaCost: null }),
    })
    const result = fixture.dependencies.transaction(() => releaseEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
        now: new Date(),
    }, fixture.dependencies))

    assert.equal(result.refundedStamina, 0)
    assert.deepEqual(result.itemList, { 500000: 6 })
    assert.deepEqual(fixture.getWrites().filter(write => write[0] === "player"), [])
}

{
    const fixture = createResourceFixture({
        activeQuest: createActiveQuest({ staminaCost: 0, entryItemCount: null }),
    })
    const result = fixture.dependencies.transaction(() => releaseEntryResources({
        playerId: 7,
        activeQuest: fixture.getActiveQuest(),
        now: new Date("2026-08-29T02:00:00Z"),
    }, {
        ...fixture.dependencies,
        getEntryCost: () => ({ itemId: 500000, itemCount: 1, stamina: 8 }),
    }))

    assert.equal(result.refundedStamina, 0)
    assert.deepEqual(result.itemList, { 500000: 5 })
    assert.deepEqual(fixture.getWrites().filter(write => write[0] === "player"), [])
}

{
    const fixture = createResourceFixture({ failAfterWrite: true })
    assert.throws(
        () => fixture.dependencies.transaction(() => commitEntryResources({
            playerId: 7,
            activeQuest: fixture.getActiveQuest(),
        }, fixture.dependencies)),
        /simulated resource transaction failure/,
    )
    assert.equal(fixture.getPlayer().totalStaminaUsed, 100)
    assert.equal(fixture.getPoints()[0].point, 1)
}

{
    const fixture = createResourceFixture({ failAfterWrite: true })
    assert.throws(
        () => fixture.dependencies.transaction(() => releaseEntryResources({
            playerId: 7,
            activeQuest: fixture.getActiveQuest(),
            now: new Date(),
        }, fixture.dependencies)),
        /simulated resource transaction failure/,
    )
    assert.equal(fixture.getPlayer().stamina, 12)
    assert.equal(fixture.getItemCount(), 4)
    assert.notEqual(fixture.getActiveQuest(), null)
}

{
    const source = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/finish/single-settlement-writes.ts"),
        "utf8",
    )
    assert.match(source, /settleSingleEntryResources\(/)
    assert.doesNotMatch(source, /settleSingleDailyChallengePoint\(/)
    const resourceSource = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/finish/single-entry-resource-settlement.ts"),
        "utf8",
    )
    assert.match(resourceSource, /questAccomplished\)\s*{\s*const committed = commitEntryResources/)
    assert.match(resourceSource, /const released = releaseEntryResources/)
}

{
    const source = fs.readFileSync(
        path.join(projectRoot, "src/multi/settlement/orchestrator.ts"),
        "utf8",
    )
    assert.match(source, /commitEntryResources\(/)
    assert.match(source, /releaseEntryResources\(/)
}

{
    const loadSource = fs.readFileSync(path.join(projectRoot, "src/routes/cn/load.ts"), "utf8")
    assert.match(loadSource, /runAbortActiveQuestTransaction\(/)
    const multiSource = fs.readFileSync(
        path.join(projectRoot, "src/multi/http/battle.ts"),
        "utf8",
    )
    assert.match(multiSource, /runAbortActiveQuestTransaction\(/)
    assert.match(multiSource, /abortResult\.cancelled/)
}

{
    const serviceSource = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/active-quest-service.ts"),
        "utf8",
    )
    assert.match(serviceSource, /releaseAbandonedMultiActiveQuest\(/)
    assert.match(serviceSource, /runAbortActiveQuestTransaction\(/)
    const roomManagerSource = fs.readFileSync(
        path.join(projectRoot, "src/multi/room/manager.ts"),
        "utf8",
    )
    assert.match(roomManagerSource, /setRoomDisbandListener\(/)
    assert.match(roomManagerSource, /notifyRoomDisbanded\(/)
    const tcpSource = fs.readFileSync(path.join(projectRoot, "src/multi/tcp/server.ts"), "utf8")
    assert.match(tcpSource, /setRoomDisbandListener\(/)
    assert.match(tcpSource, /releaseAbandonedMultiActiveQuest\(/)
}

{
    const persistencePath = require.resolve("../src/lib/quest/active-quest-persistence")
    const persistence = require(persistencePath)
    const BetterSqlite3 = require("better-sqlite3")
    const database = new BetterSqlite3(":memory:")
    database.exec(`CREATE TABLE players_active_quests (
        player_id INTEGER PRIMARY KEY,
        play_id TEXT NOT NULL,
        quest_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        continue_count INTEGER NOT NULL DEFAULT 0
    )`)
    database.prepare(`INSERT INTO players_active_quests
        (player_id, play_id, quest_id, category, continue_count)
        VALUES (7, 'legacy', 1001, 1, 0)`).run()

    persistence.ensureActiveQuestResourceCostStorageSync(database)
    const columns = database.prepare("PRAGMA table_info(players_active_quests)").all()
    assert.ok(columns.some(column => column.name === "stamina_cost"))
    assert.ok(columns.some(column => column.name === "daily_challenge_point_id"))
    assert.equal(database.prepare(
        "SELECT stamina_cost, daily_challenge_point_id FROM players_active_quests WHERE player_id = 7",
    ).get().stamina_cost, null)
    database.close()
}

{
    const dataIndexSource = fs.readFileSync(path.join(projectRoot, "src/data/index.ts"), "utf8")
assert.match(dataIndexSource, /latestVersion:\s*22/)

{
    let notification = null
    setRoomDisbandListener((roomNumber, hostPlayerId) => {
        notification = { roomNumber, hostPlayerId }
    })
    const room = createRoom(1001, 2002, 3, 1, 1001, 1, 4004)
    disbandRoom(room.room_number)
    assert.deepEqual(notification, {
        roomNumber: room.room_number,
        hostPlayerId: 2002,
    })
    notification = null
    disbandRoom(room.room_number)
    assert.equal(notification, null)
    setRoomDisbandListener(null)
}
}

console.log("quest resource lifecycle tests passed")
