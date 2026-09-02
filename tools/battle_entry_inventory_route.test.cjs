"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const entryCosts = require("../assets/quest_entry_costs.json")
const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    VIEWER_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")
const {
    assertSuccessful,
    startPayload,
} = require("./perf/single_battle_settlement_scenario_helpers.cjs")

const entry = entryCosts[`${ENTRY_CATEGORY}_${ENTRY_QUEST_ID}`]

function installItemWriteAudit(db, playerId) {
    db.exec(`
        CREATE TABLE w4_entry_item_write_audit (
            operation TEXT NOT NULL,
            after_amount INTEGER NOT NULL
        );
        CREATE TRIGGER w4_audit_entry_item_update
        AFTER UPDATE OF amount ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${entry.itemId}
        BEGIN
            INSERT INTO w4_entry_item_write_audit VALUES ('update', NEW.amount);
        END;
        CREATE TRIGGER w4_audit_entry_item_insert
        AFTER INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${entry.itemId}
        BEGIN
            INSERT INTO w4_entry_item_write_audit VALUES ('insert', NEW.amount);
        END;
    `)
}

function itemWriteAudit(db) {
    return db.prepare(`
        SELECT operation, after_amount AS afterAmount
        FROM w4_entry_item_write_audit
        ORDER BY rowid
    `).all()
}

function resetItemWriteAudit(db) {
    db.prepare("DELETE FROM w4_entry_item_write_audit").run()
}

function setCollectedTotal(db, playerId, amount) {
    db.prepare(`
        INSERT INTO players_collected_items (player_id, item_id, total_obtained)
        VALUES (?, ?, ?)
        ON CONFLICT(player_id, item_id) DO UPDATE SET total_obtained = excluded.total_obtained
    `).run(playerId, entry.itemId, amount)
}

function collectedTotal(db, playerId) {
    return db.prepare(`
        SELECT total_obtained AS totalObtained
        FROM players_collected_items
        WHERE player_id = ? AND item_id = ?
    `).get(playerId, entry.itemId)?.totalObtained ?? 0
}

function activeQuestCount(db, playerId) {
    return db.prepare(`
        SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?
    `).get(playerId).count
}

function mailCount(db, playerId) {
    return db.prepare(`SELECT COUNT(*) AS count FROM players_mails WHERE player_id = ?`)
        .get(playerId).count
}

function entryStartPayload(playId) {
    return startPayload({
        category: ENTRY_CATEGORY,
        questId: ENTRY_QUEST_ID,
        partyId: 3,
        playId,
    })
}

function entryAbortPayload(playId) {
    return {
        viewer_id: VIEWER_ID,
        api_count: 2,
        play_id: playId,
        quest_id: ENTRY_QUEST_ID,
        category: ENTRY_CATEGORY,
        finish_kind: 1,
        statistics: { clear_phase: 0, party: {} },
    }
}

test("single start deduct and explicit abort restore one absolute Item without obtained or Mail", async () => {
    await withSingleBattleHarness("w4-start-abort", async harness => {
        harness.setItem(entry.itemId, 2)
        setCollectedTotal(harness.db, harness.playerId, 77)
        installItemWriteAudit(harness.db, harness.playerId)
        const mailsBefore = mailCount(harness.db, harness.playerId)
        const playId = "w4-start-abort"

        const started = await harness.measure(() => harness.post("start", entryStartPayload(playId)))
        if (started.error) throw started.error
        assertSuccessful(started.value, "W4 entry-item start")
        assert.equal(started.value.data.item_list[entry.itemId], 1)
        assert.equal(harness.getItem(entry.itemId), 1)
        assert.deepEqual(itemWriteAudit(harness.db), [{ operation: "update", afterAmount: 1 }])
        assert.equal(collectedTotal(harness.db, harness.playerId), 77)
        assert.equal(mailCount(harness.db, harness.playerId), mailsBefore)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 1)

        resetItemWriteAudit(harness.db)
        const aborted = await harness.measure(() => harness.post("abort", entryAbortPayload(playId)))
        if (aborted.error) throw aborted.error
        assertSuccessful(aborted.value, "W4 entry-item abort")
        assert.equal(aborted.value.data.item_list[entry.itemId], 2)
        assert.equal(harness.getItem(entry.itemId), 2)
        assert.deepEqual(itemWriteAudit(harness.db), [{ operation: "update", afterAmount: 2 }])
        assert.equal(collectedTotal(harness.db, harness.playerId), 77)
        assert.equal(mailCount(harness.db, harness.playerId), mailsBefore)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 0)

        resetItemWriteAudit(harness.db)
        const repeated = await harness.measure(() => harness.post("abort", entryAbortPayload(playId)))
        if (repeated.error) throw repeated.error
        assertSuccessful(repeated.value, "W4 repeated entry-item abort")
        assert.deepEqual(repeated.value.data.item_list, {})
        assert.deepEqual(itemWriteAudit(harness.db), [])
        assert.equal(harness.getItem(entry.itemId), 2)
        assert.equal(collectedTotal(harness.db, harness.playerId), 77)
    })
})

test("single abort rolls restored Item back when active-quest deletion fails late", async () => {
    await withSingleBattleHarness("w4-abort-rollback", async harness => {
        harness.setItem(entry.itemId, 2)
        setCollectedTotal(harness.db, harness.playerId, 91)
        installItemWriteAudit(harness.db, harness.playerId)
        const playId = "w4-abort-rollback"
        const started = await harness.post("start", entryStartPayload(playId))
        assertSuccessful(started, "W4 rollback start")
        resetItemWriteAudit(harness.db)
        harness.db.exec(`
            CREATE TRIGGER w4_reject_abort_active_delete
            BEFORE DELETE ON players_active_quests
            WHEN OLD.player_id = ${harness.playerId}
            BEGIN SELECT RAISE(ABORT, 'forced W4 abort rollback'); END;
        `)

        const failed = await harness.post("abort", entryAbortPayload(playId))
        assert.equal(failed.statusCode, 500)
        assert.equal(harness.getItem(entry.itemId), 1)
        assert.deepEqual(itemWriteAudit(harness.db), [])
        assert.equal(collectedTotal(harness.db, harness.playerId), 91)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 1)

        harness.db.exec("DROP TRIGGER w4_reject_abort_active_delete")
        const retried = await harness.post("abort", entryAbortPayload(playId))
        assertSuccessful(retried, "W4 rollback abort retry")
        assert.equal(retried.data.item_list[entry.itemId], 2)
        assert.deepEqual(itemWriteAudit(harness.db), [{ operation: "update", afterAmount: 2 }])
        assert.equal(collectedTotal(harness.db, harness.playerId), 91)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 0)
    })
})

test("single failed finish restores once and a later settlement failure rolls every write back", async () => {
    await withSingleBattleHarness("w4-failed-finish", async harness => {
        harness.setItem(entry.itemId, 2)
        setCollectedTotal(harness.db, harness.playerId, 113)
        installItemWriteAudit(harness.db, harness.playerId)
        const playId = "w4-failed-finish"
        const started = await harness.post("start", entryStartPayload(playId))
        assertSuccessful(started, "W4 failed-finish start")
        resetItemWriteAudit(harness.db)

        const finish = harness.finishPayload({
            category: ENTRY_CATEGORY,
            questId: ENTRY_QUEST_ID,
            playId,
            addMana: 0,
        })
        finish.is_accomplished = false
        harness.db.exec(`
            CREATE TRIGGER w4_reject_finish_active_delete
            BEFORE DELETE ON players_active_quests
            WHEN OLD.player_id = ${harness.playerId}
            BEGIN SELECT RAISE(ABORT, 'forced W4 finish rollback'); END;
        `)

        const failed = await harness.post("finish", finish)
        assert.equal(failed.statusCode, 500)
        assert.equal(harness.getItem(entry.itemId), 1)
        assert.deepEqual(itemWriteAudit(harness.db), [])
        assert.equal(collectedTotal(harness.db, harness.playerId), 113)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 1)

        harness.db.exec("DROP TRIGGER w4_reject_finish_active_delete")
        const retried = await harness.post("finish", finish)
        assertSuccessful(retried, "W4 failed-finish retry")
        assert.equal(retried.data.item_list[entry.itemId], 2)
        assert.deepEqual(itemWriteAudit(harness.db), [{ operation: "update", afterAmount: 2 }])
        assert.equal(collectedTotal(harness.db, harness.playerId), 113)
        assert.equal(activeQuestCount(harness.db, harness.playerId), 0)
    })
})
