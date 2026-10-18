"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { pack, unpack } = require("msgpackr")

const { activeQuests } = require("../src/lib/quest/active-quest-service")
const { computeRealTimeStamina } = require("../src/lib/stamina")
const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    VIEWER_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")

const ENTRY_ITEM_ID = 10000072

function activeQuest(harness, playId) {
    return harness.createActiveQuest({
        category: ENTRY_CATEGORY,
        questId: ENTRY_QUEST_ID,
        playId,
        entryItemId: ENTRY_ITEM_ID,
        entryItemCount: 1,
    })
}

async function postAbort(app, payload) {
    return app.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/abort",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}

function decodeMsgpack(response) {
    assert.match(response.headers["content-type"], /^application\/x-msgpack/)
    return unpack(Buffer.from(response.body, "base64"))
}

function assertActiveState(harness, playId, itemCount) {
    const state = harness.snapshotState({
        category: ENTRY_CATEGORY,
        questId: ENTRY_QUEST_ID,
    })
    assert.equal(state.databaseActive?.playId, playId)
    assert.equal(state.memoryActive?.playId, playId)
    assert.equal(harness.getItem(ENTRY_ITEM_ID), itemCount)
}

test("abort rejects invalid root and identity fields as decodable MsgPack without writes", async t => {
    await withSingleBattleHarness("abort-invalid-identity", async harness => {
        const playId = "task-26c-invalid-abort"
        harness.setItem(ENTRY_ITEM_ID, 2)
        harness.insertActiveQuest(activeQuest(harness, playId))
        const valid = {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
        }
        const scenarios = [
            { name: "null body", payload: null },
            { name: "array body", payload: [] },
            { name: "numeric play id", payload: { ...valid, play_id: 7 } },
            { name: "string quest id", payload: { ...valid, quest_id: "200076009" } },
            { name: "NaN category", payload: { ...valid, category: Number.NaN } },
            { name: "positive infinite category", payload: {
                ...valid,
                category: Number.POSITIVE_INFINITY,
            } },
            { name: "negative infinite category", payload: {
                ...valid,
                category: Number.NEGATIVE_INFINITY,
            } },
        ]

        for (const scenario of scenarios) {
            await t.test(scenario.name, async () => {
                const measured = await harness.measure(() => postAbort(
                    harness.app,
                    scenario.payload,
                ))
                if (measured.error) throw measured.error
                assert.equal(measured.value.statusCode, 400)
                assert.deepEqual(decodeMsgpack(measured.value), {
                    error: "Bad Request",
                    message: "Invalid request body.",
                })
                assert.equal(measured.sql.writeStatements, 0)
                assert.equal(measured.sql.transactionStatements, 0)
                assertActiveState(harness, playId, 2)
            })
        }
    })
})

test("abort keeps explicit category zero as a mismatch without refund or deletion", async () => {
    await withSingleBattleHarness("abort-explicit-zero", async harness => {
        const playId = "task-26c-zero-abort"
        harness.setItem(ENTRY_ITEM_ID, 2)
        harness.insertActiveQuest(activeQuest(harness, playId))

        const response = await postAbort(harness.app, {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: 0,
        })

        assert.equal(response.statusCode, 200)
        assert.equal(decodeMsgpack(response).data.category_id, 0)
        assertActiveState(harness, playId, 2)
    })
})

test("abort treats null and empty optional identity fields as missing", async t => {
    for (const [name, identity] of [
        ["null identity", { play_id: null, quest_id: null, category: null }],
        ["empty play id", { play_id: "" }],
    ]) {
        await t.test(name, async () => {
            await withSingleBattleHarness(`abort-missing-${name.replaceAll(" ", "-")}`, async harness => {
                const playId = `task-26c-${name.replaceAll(" ", "-")}`
                harness.setItem(ENTRY_ITEM_ID, 2)
                harness.insertActiveQuest(activeQuest(harness, playId))

                const response = await postAbort(harness.app, {
                    viewer_id: VIEWER_ID,
                    api_count: 1,
                    ...identity,
                })

                assert.equal(response.statusCode, 200)
                const decoded = decodeMsgpack(response)
                assert.equal(decoded.data.category_id, ENTRY_CATEGORY)
                assert.deepEqual(decoded.data.item_list, { [ENTRY_ITEM_ID]: 3 })
                const state = harness.snapshotState({
                    category: ENTRY_CATEGORY,
                    questId: ENTRY_QUEST_ID,
                })
                assert.equal(state.databaseActive, null)
                assert.equal(state.memoryActive, null)
            })
        })
    }
})

test("abort rejects an invalid viewer as MsgPack before writes", async () => {
    await withSingleBattleHarness("abort-invalid-viewer", async harness => {
        const playId = "task-26c-invalid-viewer"
        harness.insertActiveQuest(activeQuest(harness, playId))

        const measured = await harness.measure(() => postAbort(harness.app, {
            viewer_id: -1,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
        }))
        if (measured.error) throw measured.error

        assert.equal(measured.value.statusCode, 400)
        assert.deepEqual(decodeMsgpack(measured.value), {
            error: "Bad Request",
            message: "Invalid viewer id.",
        })
        assert.equal(measured.sql.writeStatements, 0)
        assert.equal(measured.sql.transactionStatements, 0)
        assertActiveState(harness, playId, 0)
    })
})

test("abort response projects the refunded stamina in user_info (R-07)", async () => {
    await withSingleBattleHarness("abort-stamina-projection", async harness => {
        const playId = "r07-abort-stamina"
        const STAMINA_COST = 13
        harness.insertActiveQuest(harness.createActiveQuest({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
            playId,
            entryItemId: ENTRY_ITEM_ID,
            entryItemCount: 1,
            staminaCost: STAMINA_COST,
        }))
        const beforeLive = computeRealTimeStamina(harness.getPlayer())
        const response = await postAbort(harness.app, {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
        })
        assert.equal(response.statusCode, 200, response.body)
        const payload = decodeMsgpack(response)
        const projected = payload.data.user_info?.stamina
        assert.ok(Number.isSafeInteger(projected), `user_info.stamina 必须投影: ${JSON.stringify(payload.data.user_info)}`)
        // 投影是实时计算值（含自然恢复），事务退还在其上加 13；
        // 秒级边界内自然恢复可能再 +1，允许 1 点容差
        assert.ok(
            projected === beforeLive + STAMINA_COST || projected === beforeLive + STAMINA_COST + 1,
            `投影必须是退还后的实时值: ${projected} vs ${beforeLive + STAMINA_COST}`,
        )
        assert.ok(
            payload.data.user_info.stamina_heal_time !== undefined,
            "stamina_heal_time 必须随投影",
        )
    })
})
test("abort clears stale memory after a committed no-active observation", async () => {
    await withSingleBattleHarness("abort-stale-memory", async harness => {
        const playId = "task-26c-stale-memory"
        activeQuests[harness.playerId] = activeQuest(harness, playId)

        const response = await postAbort(harness.app, {
            viewer_id: VIEWER_ID,
            api_count: 1,
        })

        assert.equal(response.statusCode, 200)
        assert.equal(decodeMsgpack(response).data.category_id, 0)
        const state = harness.snapshotState({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
        })
        assert.equal(state.databaseActive, null)
        assert.equal(state.memoryActive, null)
    })
})

test("abort preserves memory when stored active identity mismatches", async () => {
    await withSingleBattleHarness("abort-memory-mismatch", async harness => {
        const playId = "task-26c-memory-mismatch"
        harness.insertActiveQuest(activeQuest(harness, playId))

        const response = await postAbort(harness.app, {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: 0,
        })

        assert.equal(response.statusCode, 200)
        assertActiveState(harness, playId, 0)
    })
})

test("abort preserves database, item, and memory state when its transaction fails", async () => {
    await withSingleBattleHarness("abort-transaction-failure", async harness => {
        const playId = "task-26c-abort-rollback"
        harness.setItem(ENTRY_ITEM_ID, 2)
        harness.insertActiveQuest(activeQuest(harness, playId))
        harness.db.exec(`
            CREATE TRIGGER reject_task26c_abort_delete
            BEFORE DELETE ON players_active_quests
            BEGIN SELECT RAISE(ABORT, 'task26c abort rollback'); END;
        `)

        const response = await postAbort(harness.app, {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
        })

        assert.equal(response.statusCode, 500)
        assertActiveState(harness, playId, 2)
    })
})
