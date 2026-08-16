"use strict"

const mainQuests = require("../../assets/main_quest.json")
const {
    MAIN_CATEGORY,
    MAIN_QUEST_ID,
    withSingleBattleHarness,
} = require("./single_battle_settlement_harness.cjs")
const {
    assertSuccessful,
    configuredClearReward,
    configuredSPlusReward,
    mapActiveState,
    rewardSummary,
} = require("./single_battle_settlement_scenario_helpers.cjs")

async function finishFirstClearSPlus() {
    return withSingleBattleHarness("finish-first-clear", async harness => {
        harness.makeAwakeEligible()
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-first" }))
        const before = harness.snapshotState()
        const measured = await harness.measure(() => harness.post(
            "finish",
            harness.finishPayload({ playId: "gate-task-18-first" }),
        ))
        if (measured.error) throw measured.error
        assertSuccessful(measured.value, "first-clear finish")
        const after = harness.snapshotState()
        return {
            sql: measured.sql,
            behavior: {
                quest: {
                    category: MAIN_CATEGORY,
                    questId: MAIN_QUEST_ID,
                    clearRewardId: mainQuests[String(MAIN_QUEST_ID)].clearRewardId,
                    sPlusRewardId: mainQuests[String(MAIN_QUEST_ID)].sPlusRewardId,
                    scoreRewardGroupId: mainQuests[String(MAIN_QUEST_ID)].scoreRewardGroupId,
                },
                before,
                response: measured.value,
                observedRewards: rewardSummary(measured.value, {
                    firstClear: [configuredClearReward()],
                    sPlus: [configuredSPlusReward()],
                }),
                database: mapActiveState(after),
                memory: { activeQuest: after.memoryActive },
            },
        }
    })
}

async function finishRepeatClear() {
    return withSingleBattleHarness("finish-repeat", async harness => {
        harness.makeAwakeEligible()
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-repeat-first" }))
        const firstResponse = await harness.post(
            "finish",
            harness.finishPayload({ playId: "gate-task-18-repeat-first" }),
        )
        assertSuccessful(firstResponse, "repeat setup finish")
        const firstState = harness.snapshotState()
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-repeat-second" }))
        const beforeSecond = harness.snapshotState()
        const measured = await harness.measure(() => harness.post(
            "finish",
            harness.finishPayload({ playId: "gate-task-18-repeat-second", elapsedTimeMs: 2_000 }),
        ))
        if (measured.error) throw measured.error
        assertSuccessful(measured.value, "repeat finish")
        const afterSecond = harness.snapshotState()
        return {
            sql: measured.sql,
            behavior: {
                first: {
                    observedRewards: rewardSummary(firstResponse, {
                        firstClear: [configuredClearReward()],
                        sPlus: [configuredSPlusReward()],
                    }),
                    database: mapActiveState(firstState),
                },
                beforeSecond,
                second: {
                    response: measured.value,
                    observedRewards: rewardSummary(measured.value, {
                        firstClear: [],
                        sPlus: [],
                    }),
                    database: mapActiveState(afterSecond),
                    memory: { activeQuest: afterSecond.memoryActive },
                },
            },
        }
    })
}

async function finishRankUp() {
    return withSingleBattleHarness("finish-rank-up", async harness => {
        harness.updatePlayer({ rankPoint: 9, stamina: 5 })
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-rank" }))
        const before = harness.snapshotState()
        const measured = await harness.measure(() => harness.post(
            "finish",
            harness.finishPayload({ characterId: 1, playId: "gate-task-18-rank" }),
        ))
        if (measured.error) throw measured.error
        assertSuccessful(measured.value, "rank-up finish")
        const after = harness.snapshotState()
        return {
            sql: measured.sql,
            behavior: {
                quest: {
                    category: MAIN_CATEGORY,
                    questId: MAIN_QUEST_ID,
                    rankPointReward: mainQuests[String(MAIN_QUEST_ID)].rankPointReward,
                },
                before,
                response: measured.value,
                after,
            },
        }
    })
}

async function finishLateTransactionRollback() {
    return withSingleBattleHarness("finish-rollback", async harness => {
        harness.makeAwakeEligible()
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "gate-task-18-rollback" }))
        const before = harness.snapshotState()
        harness.db.exec(`
            CREATE TRIGGER force_late_single_settlement_rollback
            BEFORE DELETE ON players_active_quests
            WHEN OLD.player_id = ${harness.playerId}
            BEGIN
                SELECT RAISE(ABORT, 'forced late settlement rollback');
            END;
        `)
        const measured = await harness.measure(() => harness.post(
            "finish",
            harness.finishPayload({ playId: "gate-task-18-rollback" }),
        ))
        if (measured.error) throw measured.error
        harness.db.exec("DROP TRIGGER force_late_single_settlement_rollback")
        const after = harness.snapshotState()
        if (measured.value.statusCode !== 500) {
            throw new Error(`rollback finish unexpectedly returned ${measured.value.statusCode}`)
        }
        return {
            sql: measured.sql,
            behavior: {
                before,
                failure: {
                    statusCode: measured.value.statusCode,
                    message: measured.value.message ?? measured.value.body ?? "",
                },
                response: measured.value,
                after,
            },
        }
    })
}

module.exports = {
    finishFirstClearSPlus,
    finishLateTransactionRollback,
    finishRankUp,
    finishRepeatClear,
}
