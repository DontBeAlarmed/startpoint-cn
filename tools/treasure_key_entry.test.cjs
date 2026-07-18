const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const worldFlipperRoot = path.resolve(projectRoot, "..")
const questEntryCosts = require(path.join(projectRoot, "assets/quest_entry_costs.json"))
const adventEventQuests = require(path.join(
    worldFlipperRoot,
    "wf-assets-cn/orderedmap/quest/event/advent_event_quest.json",
))
const challengeDungeonQuests = require(path.join(
    worldFlipperRoot,
    "wf-assets-cn/orderedmap/quest/event/challenge_dungeon_event_quest.json",
))

const {
    InsufficientEntryItemError,
    InsufficientStaminaError,
    buildStartEntryItemList,
    runStartEntryTransaction,
} = require("../src/lib/quest/start-entry")

function createFixture({
    itemCount = 4,
    stamina = 40,
    failDuringWrite = false,
    failDuringCommit = false,
} = {}) {
    let databaseState = {
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
    let publishedActiveQuest = null
    let publishedWithinTransaction = false
    let transactionActive = false
    let transactionCount = 0
    const writes = []

    function persistActiveQuest(_playerId, activeQuest) {
        assert.equal(transactionActive, true)
        writes.push("dbActiveQuest")
        databaseState.activeQuest = activeQuest
        if (failDuringWrite) throw new Error("simulated write failure")
    }

    function publishActiveQuest(_playerId, activeQuest) {
        writes.push("publishActiveQuest")
        publishedWithinTransaction ||= transactionActive
        publishedActiveQuest = activeQuest
    }

    const dependencies = {
        transaction(operation) {
            transactionCount++
            const databaseSnapshot = structuredClone(databaseState)
            transactionActive = true
            try {
                const result = operation()
                if (failDuringCommit) throw new Error("simulated commit failure")
                return result
            } catch (error) {
                databaseState = databaseSnapshot
                throw error
            } finally {
                transactionActive = false
            }
        },
        getPlayer() {
            return databaseState.player
        },
        computeStamina(player) {
            return player.stamina
        },
        getItemCount() {
            return databaseState.itemCount
        },
        updateItemCount(_playerId, _itemId, amount) {
            assert.equal(transactionActive, true)
            writes.push("item")
            databaseState.itemCount = amount
        },
        updatePlayer(update) {
            assert.equal(transactionActive, true)
            writes.push("player")
            databaseState.player = { ...databaseState.player, ...update }
        },
        persistActiveQuest,
        publishActiveQuest,
        // Compatibility path proving the old implementation publishes before commit.
        insertActiveQuest(playerId, activeQuest) {
            persistActiveQuest(playerId, activeQuest)
            publishActiveQuest(playerId, activeQuest)
        },
    }

    return {
        dependencies,
        getState: () => ({
            ...databaseState,
            publishedActiveQuest,
        }),
        getPublishedWithinTransaction: () => publishedWithinTransaction,
        getTransactionCount: () => transactionCount,
        writes,
    }
}

function createInput() {
    return {
        playerId: 7,
        entryCost: {
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
    const fixture = createFixture({ failDuringCommit: true })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        /simulated commit failure/,
    )
    assert.equal(fixture.getState().itemCount, 4)
    assert.equal(fixture.getState().player.stamina, 40)
    assert.equal(fixture.getState().player.totalStaminaUsed, 12)
    assert.equal(fixture.getState().player.partySlot, 1)
    assert.equal(fixture.getState().activeQuest, null)
    assert.equal(fixture.getState().publishedActiveQuest, null)
    assert.deepEqual(fixture.writes, ["item", "player", "dbActiveQuest"])
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
    assert.equal(fixture.getState().publishedActiveQuest, null)
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
    assert.equal(fixture.getState().publishedActiveQuest, null)
}

{
    const fixture = createFixture({ failDuringWrite: true })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        /simulated write failure/,
    )
    assert.equal(fixture.getState().itemCount, 4)
    assert.equal(fixture.getState().player.stamina, 40)
    assert.equal(fixture.getState().player.totalStaminaUsed, 12)
    assert.equal(fixture.getState().player.partySlot, 1)
    assert.equal(fixture.getState().activeQuest, null)
    assert.equal(fixture.getState().publishedActiveQuest, null)
    assert.deepEqual(fixture.writes, ["item", "player", "dbActiveQuest"])
}

{
    const fixture = createFixture({ itemCount: 4, stamina: 40 })
    for (const expectedCount of [3, 2, 1, 0]) {
        const result = runStartEntryTransaction(createInput(), fixture.dependencies)
        assert.equal(result.entryItemCount, expectedCount)
        assert.deepEqual(buildStartEntryItemList(result), { 500000: expectedCount })
    }

    assert.equal(fixture.getTransactionCount(), 4)
    assert.equal(fixture.getPublishedWithinTransaction(), false)
    assert.equal(fixture.getState().itemCount, 0)
    assert.equal(fixture.getState().player.stamina, 0)
    assert.equal(fixture.getState().player.totalStaminaUsed, 52)
    assert.equal(fixture.getState().player.partySlot, 3)
    assert.equal(fixture.getState().activeQuest.playId, "treasure-play-1")
    assert.equal(fixture.getState().publishedActiveQuest.playId, "treasure-play-1")
    assert.deepEqual(
        fixture.writes,
        Array(4).fill(["item", "player", "dbActiveQuest", "publishActiveQuest"]).flat(),
    )

    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientEntryItemError,
    )
    assert.equal(fixture.getTransactionCount(), 5)
}

assert.deepEqual(buildStartEntryItemList({ entryItemId: 500000, entryItemCount: 0 }), { 500000: 0 })
assert.deepEqual(buildStartEntryItemList({ entryItemId: null, entryItemCount: null }), {})

const treasureQuestIds = ["1038", "1039", "1040", "2001", "2002", "2003", "2004", "2005", "2006"]
const rawTreasureRows = []
function collectRawQuestRows(value, rows) {
    if (Array.isArray(value) && Array.isArray(value[0])) {
        rows.push(value[0])
        return
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const child of Object.values(value)) collectRawQuestRows(child, rows)
    }
}
collectRawQuestRows(challengeDungeonQuests, rawTreasureRows)

for (const questId of treasureQuestIds) {
    const row = rawTreasureRows.find(candidate => candidate[0] === questId)
    assert.ok(row, `missing raw treasure quest ${questId}`)
    assert.equal(Number(row[56]), 1, `treasure quest ${questId} must use Always item mode`)
    assert.deepEqual(
        questEntryCosts[`13_${questId}`],
        {
            itemId: Number(row[57]),
            itemCount: Number(row[58]),
            stamina: Number(row[70]),
        },
        `challenge dungeon quest ${questId} must preserve entry fields 57/58/70`,
    )
}

const adventTicketQuestIds = ["200013009", "200021009", "200050009", "200071009", "200076009"]
const rawAdventRows = []
for (const eventRows of Object.values(adventEventQuests)) {
    for (const wrapper of Object.values(eventRows)) {
        if (Array.isArray(wrapper) && Array.isArray(wrapper[0])) rawAdventRows.push(wrapper[0])
    }
}

for (const questId of adventTicketQuestIds) {
    const row = rawAdventRows.find(candidate => candidate[0] === questId)
    assert.ok(row, `missing raw advent ticket quest ${questId}`)
    assert.equal(Number(row[61]), 1, `advent quest ${questId} must use Always item mode`)
    assert.deepEqual(
        questEntryCosts[`7_${questId}`],
        {
            itemId: Number(row[62]),
            itemCount: Number(row[63]),
            stamina: Number(row[75]),
        },
        `advent quest ${questId} must preserve entry fields 62/63/75`,
    )
}

const routeSource = fs.readFileSync(
    path.join(projectRoot, "src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const activeQuestServiceSource = fs.readFileSync(
    path.join(projectRoot, "src/lib/quest/active-quest-service.ts"),
    "utf8",
)
const insertActiveQuestSource = activeQuestServiceSource.slice(
    activeQuestServiceSource.indexOf("export function insertActiveQuest"),
    activeQuestServiceSource.indexOf("export function runAbortActiveQuestTransaction"),
)
assert.ok(
    insertActiveQuestSource.indexOf("persistActiveQuest")
        < insertActiveQuestSource.indexOf("publishActiveQuest"),
    "insertActiveQuest must persist to DB before publishing to memory",
)
assert.match(
    routeSource,
    /["']item_list["']\s*:\s*buildStartEntryItemList\(startResult\)/,
    "quest start response must include the post-deduction item_list",
)

console.log("treasure key entry tests passed")
