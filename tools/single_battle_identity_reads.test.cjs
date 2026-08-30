"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    MAIN_CATEGORY,
    MAIN_QUEST_ID,
    VIEWER_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")
const { startPayload } = require("./perf/single_battle_settlement_scenario_helpers.cjs")

function assertSql(sql, expected, label) {
    assert.equal(sql.selectStatements, expected.selectStatements, `${label} SELECT`)
    assert.equal(sql.writeStatements, expected.writeStatements, `${label} WRITE`)
    assert.equal(sql.transactionStatements, expected.transactionStatements, `${label} TX`)
    assert.equal(sql.statements, expected.statements, `${label} statements`)
    assert.equal(sql.byTable.players?.reads ?? 0, expected.playerReads, `${label} Player SELECT`)
    assert.equal(
        sql.byTable.players_active_quests?.reads ?? 0,
        expected.activeReads,
        `${label} active SELECT`,
    )
}

test("start uses only the transaction-owned Player read", async () => {
    await withSingleBattleHarness("identity-start-reads", async harness => {
        const measured = await harness.measure(() => harness.post("start", startPayload()))
        if (measured.error) throw measured.error
        assert.equal(measured.value.statusCode, 200)
        assertSql(measured.sql, {
            statements: 25,
            selectStatements: 18,
            writeStatements: 3,
            transactionStatements: 4,
            playerReads: 3,
            activeReads: 1,
        }, "start")
    })
})

test("continue first request and replay each avoid an outer Player read", async () => {
    await withSingleBattleHarness("identity-continue-reads", async harness => {
        harness.updatePlayer({ freeVmoney: 30, vmoney: 40 })
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "task-26c-continue" }))
        const payload = {
            viewer_id: VIEWER_ID,
            api_count: 1,
            payment_type: 1,
            quest_id: MAIN_QUEST_ID,
            category: MAIN_CATEGORY,
            play_id: "task-26c-continue",
            statistics: {
                zones: [{ floor: 0, zone: 0, continue_count: 0 }],
            },
        }

        const first = await harness.measure(() => harness.post("play_continue", payload))
        if (first.error) throw first.error
        assert.equal(first.value.statusCode, 200)
        assertSql(first.sql, {
            statements: 9,
            selectStatements: 5,
            writeStatements: 2,
            transactionStatements: 2,
            playerReads: 2,
            activeReads: 1,
        }, "continue first")

        const replay = await harness.measure(() => harness.post("play_continue", payload))
        if (replay.error) throw replay.error
        assert.equal(replay.value.statusCode, 200)
        assertSql(replay.sql, {
            statements: 7,
            selectStatements: 5,
            writeStatements: 0,
            transactionStatements: 2,
            playerReads: 2,
            activeReads: 1,
        }, "continue replay")
    })
})

test("abort complete and recovery identities each read stored active once", async t => {
    for (const requestKind of ["complete", "missing"]) {
        await t.test(requestKind, async () => {
            await withSingleBattleHarness(`identity-abort-${requestKind}`, async harness => {
                const playId = `task-26c-abort-${requestKind}`
                harness.insertActiveQuest(harness.createActiveQuest({
                    category: ENTRY_CATEGORY,
                    questId: ENTRY_QUEST_ID,
                    playId,
                    entryItemId: 10000072,
                    entryItemCount: 1,
                }))
                const payload = requestKind === "complete"
                    ? {
                        viewer_id: VIEWER_ID,
                        api_count: 1,
                        play_id: playId,
                        quest_id: ENTRY_QUEST_ID,
                        category: ENTRY_CATEGORY,
                    }
                    : { viewer_id: VIEWER_ID, api_count: 1 }
                const measured = await harness.measure(() => harness.post("abort", payload))
                if (measured.error) throw measured.error
                assert.equal(measured.value.statusCode, 200)
                assertSql(measured.sql, {
                    statements: 10,
                    selectStatements: 6,
                    writeStatements: 2,
                    transactionStatements: 2,
                    playerReads: 2,
                    activeReads: 1,
                }, `abort ${requestKind}`)
            })
        })
    }
})
