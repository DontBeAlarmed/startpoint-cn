"use strict"

require("ts-node/register/transpile-only")

const entryCosts = require("../../assets/quest_entry_costs.json")
const { getStaminaCost } = require("../../src/lib/stamina-cost")
const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    MAIN_CATEGORY,
    MAIN_QUEST_ID,
    VIEWER_ID,
    withSingleBattleHarness,
} = require("./single_battle_settlement_harness.cjs")
const {
    ENTRY_QUEST_KEY,
    MAIN_QUEST_KEY,
    assertSuccessful,
    mapActiveState,
    mergeSqlSnapshots,
    startPayload,
} = require("./single_battle_settlement_scenario_helpers.cjs")

async function startNormal() {
    return withSingleBattleHarness("start-normal", async harness => {
        const stamina = getStaminaCost(MAIN_QUEST_KEY)
        const beforeState = harness.snapshotState()
        const measured = await harness.measure(() => harness.post("start", startPayload()))
        if (measured.error) throw measured.error
        assertSuccessful(measured.value, "normal start")
        const afterState = harness.snapshotState()
        return {
            sql: measured.sql,
            behavior: {
                quest: {
                    category: MAIN_CATEGORY,
                    questId: MAIN_QUEST_ID,
                    staminaBaseCost: stamina.baseCost,
                    staminaRate: stamina.rate,
                    staminaCost: stamina.cost,
                },
                before: { player: beforeState.player },
                response: measured.value,
                database: mapActiveState(afterState),
                memory: { activeQuest: afterState.memoryActive },
            },
        }
    })
}

async function abortEntryItemRefundOnce() {
    return withSingleBattleHarness("abort-entry-item", async harness => {
        const entry = entryCosts[ENTRY_QUEST_KEY]
        const stamina = getStaminaCost(ENTRY_QUEST_KEY)
        harness.setItem(entry.itemId, 2)
        const before = { itemAmount: harness.getItem(entry.itemId) }
        const started = await harness.measure(() => harness.post("start", startPayload({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
            partyId: 3,
            playId: "gate-task-18-entry",
        })))
        if (started.error) throw started.error
        assertSuccessful(started.value, "entry-item start")
        const startedState = harness.snapshotState({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
        })
        const afterStart = {
            itemAmount: harness.getItem(entry.itemId),
            databaseActive: startedState.databaseActive,
            memoryActive: startedState.memoryActive,
        }
        const abortPayload = {
            viewer_id: VIEWER_ID,
            api_count: 2,
            play_id: "gate-task-18-entry",
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
            finish_kind: 1,
            statistics: { clear_phase: 0, party: {} },
        }
        const aborted = await harness.measure(() => harness.post("abort", abortPayload))
        if (aborted.error) throw aborted.error
        assertSuccessful(aborted.value, "entry-item abort")
        const abortedState = harness.snapshotState({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
        })
        const afterAbort = {
            itemAmount: harness.getItem(entry.itemId),
            databaseActive: abortedState.databaseActive,
            memoryActive: abortedState.memoryActive,
        }
        const repeated = await harness.measure(() => harness.post("abort", abortPayload))
        if (repeated.error) throw repeated.error
        assertSuccessful(repeated.value, "repeated entry-item abort")
        const repeatedState = harness.snapshotState({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
        })
        return {
            sql: mergeSqlSnapshots([started.sql, aborted.sql, repeated.sql]),
            behavior: {
                quest: {
                    category: ENTRY_CATEGORY,
                    questId: ENTRY_QUEST_ID,
                    entryItemId: entry.itemId,
                    entryItemCount: entry.itemCount,
                    staminaBaseCost: stamina.baseCost,
                    staminaRate: stamina.rate,
                    staminaCost: stamina.cost,
                },
                before,
                startResponse: started.value,
                afterStart,
                abortResponse: aborted.value,
                afterAbort,
                repeatResponse: repeated.value,
                afterRepeat: {
                    itemAmount: harness.getItem(entry.itemId),
                    databaseActive: repeatedState.databaseActive,
                    memoryActive: repeatedState.memoryActive,
                },
            },
        }
    })
}

async function playContinueFreeThenPaid() {
    return withSingleBattleHarness("play-continue", async harness => {
        harness.updatePlayer({ freeVmoney: 30, vmoney: 40 })
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-continue" }))
        const beforeState = harness.snapshotState()
        const payload = {
            viewer_id: VIEWER_ID,
            api_count: 1,
            payment_type: 1,
            quest_id: MAIN_QUEST_ID,
            category: MAIN_CATEGORY,
            play_id: "gate-task-18-continue",
            statistics: { continue_count: 0 },
        }
        const measured = await harness.measure(() => harness.post("play_continue", payload))
        if (measured.error) throw measured.error
        assertSuccessful(measured.value, "play continue")
        const replayed = await harness.measure(() => harness.post("play_continue", payload))
        if (replayed.error) throw replayed.error
        assertSuccessful(replayed.value, "play continue replay")
        if (replayed.sql.writeStatements !== 0) {
            throw new Error("play continue replay must not write SQL")
        }
        const afterState = harness.snapshotState()
        return {
            sql: measured.sql,
            behavior: {
                before: {
                    currency: {
                        freeVmoney: beforeState.player.freeVmoney,
                        vmoney: beforeState.player.vmoney,
                    },
                    databaseContinueCount: beforeState.databaseActive.continueCount,
                    memoryContinueCount: beforeState.memoryActive.continueCount,
                },
                response: measured.value,
                after: {
                    currency: {
                        freeVmoney: afterState.player.freeVmoney,
                        vmoney: afterState.player.vmoney,
                    },
                    databaseContinueCount: afterState.databaseActive.continueCount,
                    memoryContinueCount: afterState.memoryActive.continueCount,
                },
            },
        }
    })
}

module.exports = { abortEntryItemRefundOnce, playContinueFreeThenPaid, startNormal }
