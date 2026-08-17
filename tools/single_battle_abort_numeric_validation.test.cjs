"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { pack, unpack } = require("msgpackr")

const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    VIEWER_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")

const ENTRY_ITEM_ID = 10000072
const INVALID_NUMBERS = [
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "1"],
]

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

function assertActiveState(harness, playId) {
    const state = harness.snapshotState({
        category: ENTRY_CATEGORY,
        questId: ENTRY_QUEST_ID,
    })
    assert.equal(state.databaseActive?.playId, playId)
    assert.equal(state.memoryActive?.playId, playId)
    assert.equal(harness.getItem(ENTRY_ITEM_ID), 2)
}

async function assertInvalidField(t, field) {
    await withSingleBattleHarness(`abort-invalid-${field}`, async harness => {
        const playId = `task-26c-invalid-${field}`
        harness.setItem(ENTRY_ITEM_ID, 2)
        harness.insertActiveQuest(activeQuest(harness, playId))
        const valid = {
            viewer_id: VIEWER_ID,
            api_count: 1,
            play_id: playId,
            quest_id: ENTRY_QUEST_ID,
            category: ENTRY_CATEGORY,
        }

        for (const [name, value] of INVALID_NUMBERS) {
            await t.test(name, async () => {
                const measured = await harness.measure(() => postAbort(harness.app, {
                    ...valid,
                    [field]: value,
                }))
                if (measured.error) throw measured.error

                assert.equal(measured.value.statusCode, 400)
                assert.deepEqual(decodeMsgpack(measured.value), {
                    error: "Bad Request",
                    message: "Invalid request body.",
                })
                assert.equal(measured.sql.selectStatements, 0, "must not query session")
                assert.equal(measured.sql.writeStatements, 0)
                assert.equal(measured.sql.transactionStatements, 0)
                assertActiveState(harness, playId)
            })
        }
    })
}

test("abort rejects every invalid explicit quest_id before session lookup", async t => {
    await assertInvalidField(t, "quest_id")
})

test("abort rejects every invalid explicit category before session lookup", async t => {
    await assertInvalidField(t, "category")
})

test("abort keeps zero quest and category values as explicit mismatches", async t => {
    for (const field of ["quest_id", "category"]) {
        await t.test(field, async () => {
            await withSingleBattleHarness(`abort-zero-${field}`, async harness => {
                const playId = `task-26c-zero-${field}`
                harness.setItem(ENTRY_ITEM_ID, 2)
                harness.insertActiveQuest(activeQuest(harness, playId))

                const response = await postAbort(harness.app, {
                    viewer_id: VIEWER_ID,
                    api_count: 1,
                    play_id: playId,
                    quest_id: field === "quest_id" ? 0 : ENTRY_QUEST_ID,
                    category: field === "category" ? 0 : ENTRY_CATEGORY,
                })

                assert.equal(response.statusCode, 200)
                assert.equal(decodeMsgpack(response).data.category_id,
                    field === "category" ? 0 : ENTRY_CATEGORY)
                assertActiveState(harness, playId)
            })
        })
    }
})
