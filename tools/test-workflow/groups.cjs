const TEST_GROUPS = Object.freeze({
    "quick:workflow": {
        execution: "parallel",
        tests: [
            "tools/test-workflow/select-tests.test.cjs",
            "tools/test-workflow/run.test.cjs",
        ],
    },
    "quick:gacha": {
        execution: "parallel",
        tests: [
            "tools/gacha_draw_weights.test.cjs",
            "tools/gacha_equipment_movie.test.cjs",
            "tools/gacha_exec_plan.test.cjs",
            "tools/gacha_rules.test.cjs",
        ],
    },
    "quick:quest": {
        execution: "parallel",
        tests: [
            "tools/active_quest_service_import.test.cjs",
            "tools/quest_abort_route.test.cjs",
            "tools/special_quest_flow.test.cjs",
        ],
    },
    "quick:protocol": {
        execution: "parallel",
        tests: [
            "tools/msgpack_compat.test.cjs",
            "tools/multi_player_context.test.cjs",
        ],
    },
    "integration:compiled": {
        execution: "serial",
        tests: [
            "tools/character_awake_refresh.test.cjs",
            "tools/character_stack.test.cjs",
            "tools/equipment_enhancement.test.cjs",
            "tools/event_currency.test.cjs",
            "tools/inventory_rules.test.cjs",
            "tools/mission_completion.test.cjs",
        ],
    },
    "integration:database": {
        execution: "serial",
        tests: [
            "tools/test-workflow/database-isolation.test.cjs",
            "tools/carnival_rewards.test.cjs",
            "tools/character_awake_settlement.test.cjs",
            "tools/character_awake_unlock.test.cjs",
            "tools/mission_storage.test.cjs",
            "tools/quest_entry_lifecycle.test.cjs",
            "tools/quest_host_finish.test.cjs",
            "tools/rush_event_shop.test.cjs",
            "tools/rush_event_shop_route.test.cjs",
            "tools/score_attack_route_transaction.test.cjs",
            "tools/special_quest_party.test.cjs",
        ],
    },
    "integration:cdn": {
        execution: "serial",
        tests: [],
    },
    admin: {
        execution: "parallel",
        tests: [
            "tests/admin-account-save-ui.test.js",
            "tests/admin-clairvoyance.test.js",
            "tests/admin-mail-rules.test.js",
            "tests/admin-mail-ui-source.test.js",
            "tests/admin-time-clairvoyance-ui-source.test.js",
        ],
    },
    generator: {
        execution: "serial",
        tests: [
            "tools/box_gacha_reset.test.cjs",
            "tools/gacha_odds_export.test.cjs",
            "tools/rebuild_gacha_from_odds.test.cjs",
            "tools/score_attack_event.test.cjs",
            "tools/star_grain_material_pack.test.cjs",
            "tools/treasure_key_entry.test.cjs",
        ],
    },
})

const quickGroups = Object.keys(TEST_GROUPS).filter(name => name.startsWith("quick:"))
const integrationGroups = Object.keys(TEST_GROUPS).filter(name => name.startsWith("integration:"))

const AGGREGATE_GROUPS = Object.freeze({
    quick: Object.freeze(quickGroups),
    integration: Object.freeze(integrationGroups),
    admin: Object.freeze(["admin"]),
    generator: Object.freeze(["generator"]),
    full: Object.freeze([...quickGroups, ...integrationGroups, "admin"]),
})

module.exports = {
    AGGREGATE_GROUPS,
    TEST_GROUPS,
}
