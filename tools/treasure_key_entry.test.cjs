const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")

const {
    InsufficientEntryItemError,
    InsufficientStaminaError,
    PlayerNotFoundError,
    buildStartEntryItemList,
    runStartEntryTransaction,
} = require("../src/lib/quest/start-entry")

function createFixture({
    itemCount = 4,
    stamina = 40,
    failDuringWrite = false,
    failDuringCommit = false,
    failDuringAfterPersist = false,
    beforeTransaction,
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
    let inventoryContextCount = 0
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
            beforeTransaction?.(databaseState)
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
        withEntryItemInventory(_playerId, operation) {
            assert.equal(transactionActive, true)
            inventoryContextCount++
            let afterAmount = databaseState.itemCount
            let touched = false
            return operation({
                readAmount() { return afterAmount },
                deduct(_itemId, amount) {
                    afterAmount -= amount
                    touched = true
                    return { afterAmount, obtainedAmount: 0 }
                },
                restore(_itemId, amount) {
                    afterAmount += amount
                    touched = true
                    return { afterAmount, obtainedAmount: 0 }
                },
                flush() {
                    if (!touched) return
                    writes.push("item")
                    databaseState.itemCount = afterAmount
                },
            })
        },
        updatePlayer(update) {
            assert.equal(transactionActive, true)
            writes.push("player")
            databaseState.player = { ...databaseState.player, ...update }
        },
        persistActiveQuest,
        publishActiveQuest,
        afterPersist() {
            assert.equal(transactionActive, true)
            writes.push("afterPersist")
            if (failDuringAfterPersist) throw new Error("simulated mission settlement failure")
        },
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
        getInventoryContextCount: () => inventoryContextCount,
        writes,
    }
}

{
    const fixture = createFixture({ failDuringAfterPersist: true })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        /simulated mission settlement failure/,
    )
    assert.equal(fixture.getState().itemCount, 4)
    assert.equal(fixture.getState().player.stamina, 40)
    assert.equal(fixture.getState().activeQuest, null)
    assert.equal(fixture.getState().publishedActiveQuest, null)
    assert.deepEqual(fixture.writes, ["item", "player", "dbActiveQuest", "afterPersist"])
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
    assert.deepEqual(fixture.writes, ["item", "player", "dbActiveQuest", "afterPersist"])
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
    const fixture = createFixture({ itemCount: 0, stamina: 0 })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientEntryItemError,
        "entry Item shortage must remain higher priority than stamina shortage",
    )
    assert.deepEqual(fixture.writes, [])
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
    const fixture = createFixture({
        itemCount: 4,
        stamina: 40,
        beforeTransaction: state => { state.player.stamina = 9 },
    })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientStaminaError,
    )
    assert.equal(fixture.getState().player.stamina, 9)
    assert.deepEqual(fixture.writes, [])
}

{
    const fixture = createFixture({
        beforeTransaction: state => { state.player = null },
    })
    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        PlayerNotFoundError,
    )
    assert.equal(fixture.getState().player, null)
    assert.deepEqual(fixture.writes, [])
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
        assert.equal(result.beforeStamina, expectedCount * 10 + 10)
        assert.equal(result.entryItemCount, expectedCount)
        assert.deepEqual(buildStartEntryItemList(result), { 500000: expectedCount })
    }

    assert.equal(fixture.getTransactionCount(), 4)
    assert.equal(fixture.getPublishedWithinTransaction(), false)
    assert.equal(fixture.getState().itemCount, 0)
    assert.equal(fixture.getState().player.stamina, 0)
    assert.equal(fixture.getState().player.totalStaminaUsed, 12)
    assert.equal(fixture.getState().player.partySlot, 3)
    assert.equal(fixture.getState().activeQuest.playId, "treasure-play-1")
    assert.equal(fixture.getState().publishedActiveQuest.playId, "treasure-play-1")
    assert.deepEqual(
        fixture.writes,
        Array(4).fill(["item", "player", "dbActiveQuest", "afterPersist", "publishActiveQuest"]).flat(),
    )

    assert.throws(
        () => runStartEntryTransaction(createInput(), fixture.dependencies),
        InsufficientEntryItemError,
    )
    assert.equal(fixture.getTransactionCount(), 5)
}

assert.deepEqual(buildStartEntryItemList({ entryItemId: 500000, entryItemCount: 0 }), { 500000: 0 })
assert.deepEqual(buildStartEntryItemList({ entryItemId: null, entryItemCount: null }), {})

{
    const fixture = createFixture()
    const input = createInput()
    input.entryCost = undefined
    input.staminaCost = 0
    input.activeQuest.entryItemId = undefined
    const result = runStartEntryTransaction(input, fixture.dependencies)
    assert.equal(result.entryItemId, null)
    assert.equal(result.entryItemCount, null)
    assert.equal(fixture.getInventoryContextCount(), 0)
    assert.equal(fixture.writes.includes("item"), false)
}

{
    const order = []
    let transactionActive = false
    runStartEntryTransaction(createInput(), {
        transaction(operation) {
            order.push("transaction:start")
            transactionActive = true
            try { return operation() } finally {
                transactionActive = false
                order.push("transaction:end")
            }
        },
        getActiveQuest() {
            order.push("activeQuest")
            return null
        },
        getPlayer() {
            order.push("player")
            return {
                id: 7, stamina: 40, staminaHealTime: new Date(0),
                rankPoint: 0, totalStaminaUsed: 0, partySlot: 1,
            }
        },
        beforePersist() { order.push("beforePersist") },
        withEntryItemInventory(_playerId, operation) {
            assert.equal(transactionActive, true)
            return operation({
                readAmount() { order.push("item:read"); return 4 },
                deduct() {
                    order.push("item:deduct")
                    return { afterAmount: 3, obtainedAmount: 0 }
                },
                restore() { throw new Error("start must not restore") },
                flush() { order.push("item:flush") },
            })
        },
        computeStamina() { order.push("stamina"); return 40 },
        updatePlayer() { order.push("player:update") },
        persistActiveQuest() { order.push("activeQuest:persist") },
        afterPersist() { order.push("afterPersist") },
        publishActiveQuest() {
            assert.equal(transactionActive, false)
            order.push("activeQuest:publish")
        },
    })
    assert.deepEqual(order, [
        "transaction:start",
        "activeQuest",
        "player",
        "beforePersist",
        "item:read",
        "stamina",
        "item:deduct",
        "item:flush",
        "player:update",
        "activeQuest:persist",
        "afterPersist",
        "transaction:end",
        "activeQuest:publish",
    ])
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
const persistIndex = insertActiveQuestSource.indexOf("persistActiveQuest")
const publishIndex = insertActiveQuestSource.indexOf("publishActiveQuest")
assert.ok(persistIndex >= 0, "insertActiveQuest must call persistActiveQuest")
assert.ok(publishIndex >= 0, "insertActiveQuest must call publishActiveQuest")
assert.ok(
    persistIndex < publishIndex,
    "insertActiveQuest must persist to DB before publishing to memory",
)
assert.match(
    routeSource,
    /["']item_list["']\s*:\s*buildStartEntryItemList\(startResult\)/,
    "quest start response must include the post-deduction item_list",
)

console.log("treasure key entry tests passed")
