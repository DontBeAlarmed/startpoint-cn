"use strict"

const {
    finishFirstClearSPlus,
    finishLateTransactionRollback,
    finishRankUp,
    finishRepeatClear,
} = require("./single_battle_settlement_finish_scenarios.cjs")
const {
    abortEntryItemRefundOnce,
    playContinueFreeThenPaid,
    startNormal,
} = require("./single_battle_settlement_lifecycle_scenarios.cjs")
const {
    mergeSqlSnapshots,
} = require("./single_battle_settlement_scenario_helpers.cjs")

const SCENARIOS = Object.freeze([
    { name: "abort_entry_item_refund_once", run: abortEntryItemRefundOnce },
    { name: "finish_first_clear_s_plus", run: finishFirstClearSPlus },
    { name: "finish_late_transaction_rollback", run: finishLateTransactionRollback },
    { name: "finish_rank_up", run: finishRankUp },
    { name: "finish_repeat_clear", run: finishRepeatClear },
    { name: "play_continue_free_then_paid", run: playContinueFreeThenPaid },
    { name: "start_normal", run: startNormal },
])

module.exports = { SCENARIOS, mergeSqlSnapshots }
