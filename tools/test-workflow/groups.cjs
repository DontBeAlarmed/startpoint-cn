const TEST_GROUPS = Object.freeze({
    "quick:workflow": {
        execution: "parallel",
        tests: [
            "tools/test-workflow/benchmark.test.cjs",
            "tools/test-workflow/package-scripts.test.cjs",
            "tools/test-workflow/select-tests.test.cjs",
            "tools/test-workflow/run.test.cjs",
            "tools/test-workflow/verify-cn-build.test.cjs",
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
    "quick:cdn": {
        execution: "parallel",
        tests: [
            "tools/cdn_catalog.test.cjs",
            "tools/cdn_paths.test.cjs",
            "tools/cdn_planner.test.cjs",
            "tools/cdn_types.test.cjs",
        ],
    },
    "quick:content": {
        execution: "parallel",
        tests: [
            "tools/content_sync.test.cjs",
            "tools/content_object_store.test.cjs",
            "tools/content_archive_index.test.cjs",
            "tools/content_ordered_map.test.cjs",
            "tools/content_registry.test.cjs",
            "tools/content_schema.test.cjs",
        ],
    },
    "integration:compiled": {
        execution: "parallel",
        tests: [
            "tools/quest_abort_route.test.cjs",
            "tools/score_attack_event.test.cjs",
            "tools/treasure_key_entry.test.cjs",
        ],
    },
    "integration:mission-compiled": {
        execution: "parallel",
        tests: [
            "tools/character_awake_refresh.test.cjs",
            "tools/mission_completion.test.cjs",
        ],
    },
    "integration:rules": {
        execution: "parallel",
        tests: [
            "tools/character_stack.test.cjs",
            "tools/equipment_enhancement.test.cjs",
            "tools/event_currency.test.cjs",
            "tools/inventory_rules.test.cjs",
        ],
    },
    "integration:database": {
        execution: "serial",
        tests: [
            "tools/test-workflow/database-isolation.test.cjs",
        ],
    },
    "integration:event": {
        execution: "parallel",
        tests: [
            "tools/carnival_rewards.test.cjs",
            "tools/rush_event_shop.test.cjs",
            "tools/rush_event_shop_route.test.cjs",
            "tools/score_attack_route_transaction.test.cjs",
        ],
    },
    "integration:mission": {
        execution: "parallel",
        tests: [
            "tools/character_awake_settlement.test.cjs",
            "tools/character_awake_unlock.test.cjs",
            "tools/mission_storage.test.cjs",
        ],
    },
    "integration:quest": {
        execution: "parallel",
        tests: [
            "tools/quest_entry_lifecycle.test.cjs",
            "tools/quest_host_finish.test.cjs",
        ],
    },
    "integration:party": {
        execution: "parallel",
        tests: [
            "tools/special_quest_party.test.cjs",
        ],
    },
    "integration:cdn": {
        execution: "serial",
        tests: [
            "tools/cdn_asset_import.test.cjs",
            "tools/cn_asset_route.test.cjs",
            "tools/cdn_catalog_provider.test.cjs",
            "tools/cdn_runtime_manifest.test.cjs",
            "tools/cdn_audit.test.cjs",
            "tools/cdn_files.test.cjs",
        ],
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
            "tools/score_attack_event_data.test.cjs",
            "tools/star_grain_material_pack.test.cjs",
            "tools/treasure_key_entry_data.test.cjs",
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
