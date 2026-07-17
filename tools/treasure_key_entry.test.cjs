const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const worldFlipperRoot = path.resolve(projectRoot, "..")
const questEntryCosts = require(path.join(projectRoot, "assets/quest_entry_costs.json"))
const challengeDungeonQuests = require(path.join(
    worldFlipperRoot,
    "wf-assets-cn/orderedmap/quest/event/challenge_dungeon_event_quest.json",
))

const treasureQuestIds = ["2001", "2002", "2003", "2004", "2005", "2006"]
const rawTreasureRows = Object.values(challengeDungeonQuests["2"]).map(wrapper => wrapper[0])

for (const questId of treasureQuestIds) {
    const row = rawTreasureRows.find(candidate => candidate[0] === questId)
    assert.ok(row, `missing raw treasure quest ${questId}`)
    assert.deepEqual(
        questEntryCosts[`13_${questId}`],
        {
            itemMode: Number(row[56]),
            itemId: Number(row[57]),
            itemCount: Number(row[58]),
            stamina: Number(row[70]),
        },
        `treasure quest ${questId} must preserve entry fields 56/57/58/70`,
    )
}

const {
    InsufficientEntryItemError,
    InsufficientStaminaError,
    buildStartEntryItemList,
    runStartEntryTransaction,
} = require("../src/lib/quest/start-entry")

function createFixture({ itemCount = 4, stamina = 40 } = {}) {
    let state = {
        itemCount,
        player: {
            id: 7,
            stamina,
            staminaHealTime: new Date("2026-07-18T00:00:00.000Z"),
            rankPoint: 0,
            totalStaminaUsed: 12,
            partySlot: 1,
        },
        activeQuest: null,
    }
    let transactionActive = false
    let transactionCount = 0
    const writes = []

    const dependencies = {
        transaction(operation) {
            transactionCount++
            const snapshot = structuredClone(state)
            transactionActive = true
            try {
                return operation()
            } catch (error) {
                state = snapshot
                throw error
            } finally {
                transactionActive = false
            }
        },
        getPlayer() {
            return state.player
        },
        computeStamina(player) {
            return player.stamina
        },
        getItemCount() {
            return state.itemCount
        },
        updateItemCount(_playerId, _itemId, amount) {
            assert.equal(transactionActive, true)
            writes.push("item")
            state.itemCount = amount
        },
        updatePlayer(update) {
            assert.equal(transactionActive, true)
            writes.push("player")
            state.player = { ...state.player, ...update }
        },
        insertActiveQuest(_playerId, activeQuest) {
            assert.equal(transactionActive, true)
            writes.push("activeQuest")
            state.activeQuest = activeQuest
        },
    }

    return {
        dependencies,
        getState: () => state,
        getTransactionCount: () => transactionCount,
        writes,
    }
}

function createInput() {
    return {
        playerId: 7,
        entryCost: {
            itemMode: 1,
            itemId: 500000,
            itemCount: 1,
            stamina: 10,
        },
        staminaCost: 10,
        partyId: 3,
        updatePartySlot: true,
        activeQuest: {
            playerId: 7,
            playId: "treasure-play-1",
            questId: 2001,
            category: 13,
            useBossBoostPoint: false,
            useBoostPoint: false,
            isAutoStartMode: true,
            isMulti: false,
            roomNumber: null,
            entryItemId: 500000,
            eventId: null,
            continueCount: 0,
        },
        now: new Date("2026-07-18T01:00:00.000Z"),
    }
}

{
    const fixture = createFixture({ itemCount: 0, stamina: 40 })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientEntryItemError,
    )
    assert.deepEqual(fixture.writes, [])
    assert.equal(fixture.getTransactionCount(), 1)
    assert.equal(fixture.getState().player.stamina, 40)
    assert.equal(fixture.getState().activeQuest, null)
}

{
    const fixture = createFixture({ itemCount: 4, stamina: 9 })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientStaminaError,
    )
    assert.deepEqual(fixture.writes, [])
    assert.equal(fixture.getTransactionCount(), 1)
    assert.equal(fixture.getState().itemCount, 4)
    assert.equal(fixture.getState().activeQuest, null)
}

{
    const fixture = createFixture({ itemCount: 4, stamina: 40 })
    for (const expectedCount of [3, 2, 1, 0]) {
        const result = runStartEntryTransaction(createInput(), fixture.dependencies)
        assert.equal(result.entryItemCount, expectedCount)
        assert.deepEqual(buildStartEntryItemList(result), { 500000: expectedCount })
    }

    assert.equal(fixture.getTransactionCount(), 4)
    assert.equal(fixture.getState().itemCount, 0)
    assert.equal(fixture.getState().player.stamina, 0)
    assert.equal(fixture.getState().player.totalStaminaUsed, 52)
    assert.equal(fixture.getState().player.partySlot, 3)
    assert.equal(fixture.getState().activeQuest.playId, "treasure-play-1")
    assert.deepEqual(fixture.writes, Array(4).fill(["item", "player", "activeQuest"]).flat())

    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientEntryItemError,
    )
    assert.equal(fixture.getTransactionCount(), 5)
    assert.deepEqual(fixture.writes, Array(4).fill(["item", "player", "activeQuest"]).flat())
}

assert.deepEqual(buildStartEntryItemList({ entryItemId: 500000, entryItemCount: 0 }), { 500000: 0 })
assert.deepEqual(buildStartEntryItemList({ entryItemId: null, entryItemCount: null }), {})

const routeSource = fs.readFileSync(
    path.join(projectRoot, "src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const insertActiveQuestSource = routeSource.slice(
    routeSource.indexOf("export function insertActiveQuest"),
    routeSource.indexOf("const routes = async"),
)
assert.ok(
    insertActiveQuestSource.indexOf("insertPlayerActiveQuestSync")
        < insertActiveQuestSource.indexOf("activeQuests[playerId] = quest"),
    "insertActiveQuest must persist to DB before updating memory",
)

console.log("treasure key entry tests passed")
