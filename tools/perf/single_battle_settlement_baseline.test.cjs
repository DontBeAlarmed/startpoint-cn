"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    SNAPSHOT_PATH,
    parseArgs,
    runSingleBattleSettlementBaseline,
} = require("./single_battle_settlement_baseline.cjs")
const {
    normalizeDynamicFields,
} = require("./single_battle_settlement_fixture.cjs")

const EXPECTED_SCENARIOS = [
    "abort_entry_item_refund_once",
    "finish_first_clear_s_plus",
    "finish_late_transaction_rollback",
    "finish_rank_up",
    "finish_repeat_clear",
    "play_continue_free_then_paid",
    "start_normal",
]

test("single battle baseline captures isolated real Fastify and SQLite scenarios", async () => {
    const report = await runSingleBattleSettlementBaseline()

    assert.deepEqual(Object.keys(report.scenarios), EXPECTED_SCENARIOS)
    for (const [name, scenario] of Object.entries(report.scenarios)) {
        assert.match(scenario.behaviorSha256, /^[a-f0-9]{64}$/, name)
        assert.ok(scenario.sql.statements > 0, name)
        assert.equal(
            scenario.sql.statements,
            scenario.sql.selectStatements
                + scenario.sql.writeStatements
                + scenario.sql.transactionStatements,
            name,
        )
        assert.ok(Object.keys(scenario.sql.byTable).length > 0, name)
        assert.equal(JSON.stringify(scenario).includes("single-battle-settlement-"), false, name)
    }

    const start = report.scenarios.start_normal.behavior
    assert.equal(start.database.player.partySlot, 2)
    assert.equal(start.database.player.stamina, start.before.player.stamina - start.quest.staminaCost)
    assert.equal(start.response.data.user_info.stamina, start.database.player.stamina)
    assert.equal(start.before.player.staminaHealTime, "fixed-fixture-time")
    assert.equal(start.database.player.staminaHealTime, "within-request-window")
    assert.equal(
        start.response.data.user_info.stamina_heal_time,
        "matches-database-virtual-time",
    )

    const abort = report.scenarios.abort_entry_item_refund_once.behavior
    assert.equal(abort.afterStart.itemAmount, abort.before.itemAmount - abort.quest.entryItemCount)
    assert.equal(abort.afterAbort.itemAmount, abort.before.itemAmount)
    assert.equal(abort.afterRepeat.itemAmount, abort.before.itemAmount)
    assert.equal(abort.afterAbort.databaseActive, null)
    assert.equal(abort.afterAbort.memoryActive, null)

    const first = report.scenarios.finish_first_clear_s_plus.behavior
    assert.equal(first.database.questProgress.finished, true)
    assert.equal(first.database.questProgress.clearRank, 5)
    assert.equal(first.database.activeQuest, null)
    assert.equal(first.memory.activeQuest, null)
    assert.ok(first.observedRewards.firstClear.length > 0)
    assert.ok(first.observedRewards.score.length > 0)
    assert.ok(first.observedRewards.additional.length > 0)
    assert.ok(first.observedRewards.mission.length > 0)
    assert.ok(first.observedRewards.awake.length > 0)

    const repeated = report.scenarios.finish_repeat_clear.behavior
    assert.deepEqual(repeated.second.observedRewards.firstClear, [])
    assert.deepEqual(repeated.second.observedRewards.sPlus, [])
    assert.ok(repeated.second.observedRewards.score.length > 0)

    const rankUp = report.scenarios.finish_rank_up.behavior
    assert.ok(rankUp.after.player.rankPoint > rankUp.before.player.rankPoint)
    assert.ok(rankUp.after.rankDegree > rankUp.before.rankDegree)
    assert.ok(rankUp.after.player.stamina > rankUp.before.player.stamina)
    assert.equal(rankUp.response.data.user_info.rank_point, rankUp.after.player.rankPoint)
    assert.equal(rankUp.response.data.user_info.degree_id, rankUp.after.player.degreeId)
    assert.equal(rankUp.response.data.user_info.stamina, rankUp.after.player.stamina)
    assert.equal(rankUp.before.player.staminaHealTime, "fixed-fixture-time")
    assert.equal(rankUp.after.player.staminaHealTime, "within-request-window")
    assert.equal(
        rankUp.response.data.user_info.stamina_heal_time,
        "matches-database-virtual-time",
    )

    const continued = report.scenarios.play_continue_free_then_paid.behavior
    assert.deepEqual(continued.before.currency, { freeVmoney: 30, vmoney: 40 })
    assert.deepEqual(continued.after.currency, { freeVmoney: 0, vmoney: 20 })
    assert.equal(continued.after.databaseContinueCount, 1)
    assert.equal(continued.after.memoryContinueCount, 1)

    const rollback = report.scenarios.finish_late_transaction_rollback.behavior
    assert.match(rollback.failure.message, /forced late settlement rollback/)
    assert.deepEqual(rollback.after, rollback.before)
    assert.notEqual(rollback.after.databaseActive, null)
    assert.notEqual(rollback.after.memoryActive, null)
})

test("checked snapshot matches a fresh baseline run", async () => {
    const current = await runSingleBattleSettlementBaseline()
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"))
    assert.deepEqual(current, snapshot)
})

test("baseline CLI is read-only unless --write is explicit", () => {
    assert.deepEqual(parseArgs([]), { write: false })
    assert.deepEqual(parseArgs(["--write"]), { write: true })
    assert.throws(() => parseArgs(["--output", "elsewhere.json"]), /unknown argument/)
    assert.throws(() => parseArgs(["--write", "--write"]), /duplicate --write/)
})

test("stamina heal time normalization rejects malformed database values", () => {
    const valid = new Date("2025-01-01T00:00:00.000Z")
    const context = {
        beforeDatabaseValue: valid,
        requestStartedAtMs: valid.getTime(),
        requestEndedAtMs: valid.getTime() + 1_000,
        timeOffsetMs: 0,
    }
    for (const [value, message] of [
        [null, /database staminaHealTime is null/],
        [valid.getTime(), /database staminaHealTime is a number/],
        ["not-a-date", /database staminaHealTime is a string/],
        [new Date(Number.NaN), /database staminaHealTime is Invalid Date/],
    ]) {
        assert.throws(() => normalizeDynamicFields(
            { stamina_heal_time: 1_735_689_600 },
            { ...context, afterDatabaseValue: value },
        ), message)
    }
})

test("stamina heal time normalization validates request window and response relation", () => {
    const before = new Date("2025-01-01T00:00:00.000Z")
    const after = new Date("2025-01-01T00:00:01.500Z")
    const context = {
        beforeDatabaseValue: before,
        afterDatabaseValue: after,
        requestStartedAtMs: after.getTime() - 500,
        requestEndedAtMs: after.getTime() + 500,
        timeOffsetMs: 60_000,
    }
    assert.deepEqual(
        normalizeDynamicFields({ stamina_heal_time: 1_735_689_661 }, context),
        { stamina_heal_time: "matches-database-virtual-time" },
    )
    assert.throws(
        () => normalizeDynamicFields({ stamina_heal_time: null }, context),
        /response stamina_heal_time is null/,
    )
    assert.throws(
        () => normalizeDynamicFields({ stamina_heal_time: 1_735_689_662 }, context),
        /does not match database virtual time/,
    )
    assert.throws(
        () => normalizeDynamicFields(
            { stamina_heal_time: 1_735_689_661 },
            { ...context, requestStartedAtMs: after.getTime() + 1 },
        ),
        /outside request window/,
    )
})

test("single battle baseline keeps runtime and scenario responsibilities focused", () => {
    for (const file of [
        "single_battle_settlement_fixture.cjs",
        "single_battle_settlement_harness.cjs",
        "single_battle_settlement_request_runner.cjs",
        "single_battle_settlement_time.cjs",
        "single_battle_settlement_scenario_helpers.cjs",
        "single_battle_settlement_lifecycle_scenarios.cjs",
        "single_battle_settlement_finish_scenarios.cjs",
        "single_battle_settlement_scenarios.cjs",
    ]) {
        const contents = fs.readFileSync(path.join(__dirname, file), "utf8")
        assert.ok(contents.split("\n").length <= 300, `${file} exceeds 300 lines`)
    }
})
