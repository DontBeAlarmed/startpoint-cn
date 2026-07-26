const TEST_GROUPS = Object.freeze({
    "quick:workflow": {
        execution: "parallel",
        tests: [
            "tools/docs_check.test.cjs",
            "tools/test-workflow/benchmark.test.cjs",
            "tools/test-workflow/build-cn.test.cjs",
            "tools/test-workflow/package-scripts.test.cjs",
            "tools/test-workflow/select-tests.test.cjs",
            "tools/test-workflow/run.test.cjs",
            "tools/test-workflow/verify-cn-build.test.cjs",
        ],
    },
    "quick:runtime": {
        execution: "parallel",
        tests: [
            "tools/server_bundle.test.cjs",
            "tools/runtime_bundle_metadata.test.cjs",
            "tools/runtime_config.test.cjs",
            "tools/runtime_health.test.cjs",
            "tools/runtime_lifecycle.test.cjs",
        ],
    },
    "quick:seed": {
        execution: "parallel",
        tests: [
            "tools/seed_api.test.cjs",
            "tools/seed_state.test.cjs",
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
            "tools/handshake_lifecycle.test.cjs",
            "tools/lobby_lifecycle.test.cjs",
            "tools/msgpack_compat.test.cjs",
            "tools/multi_player_context.test.cjs",
            "tools/npc_contributor_names.test.cjs",
            "tools/npc_nickname_pool.test.cjs",
            "tools/room_cleanup_lifecycle.test.cjs",
            "tools/session_server_lifecycle.test.cjs",
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
        timeoutMs: 60_000,
        tests: [
            "tools/character_content.test.cjs",
            "tools/content_character_converter.test.cjs",
            "tools/content_skill_effects_converter.test.cjs",
            "tools/content_amf3.test.cjs",
            "tools/content_gacha_converter.test.cjs",
            "tools/content_shop_converter.test.cjs",
            "tools/gacha_repository.test.cjs",
            "tools/shop_repository.test.cjs",
            "tools/content_repository.test.cjs",
            "tools/content_snapshot_configuration.test.cjs",
            "tools/content_startup.test.cjs",
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
    "integration:runtime": {
        execution: "serial",
        tests: [
            "tools/runtime_compiled_smoke.test.cjs",
        ],
    },
    "integration:content": {
        execution: "serial",
        tests: [
            "tools/content_dynamic_catalog.test.cjs",
            "tools/content_dynamic_catalog_integration.test.cjs",
            "tools/shop_repository_integration.test.cjs",
            "tools/content_sync_smoke.test.cjs",
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
            "tools/mail_notification.test.cjs",
            "tools/mail_notification_write_routes.test.cjs",
        ],
    },
    "integration:database": {
        execution: "serial",
        tests: [
            "tools/test-workflow/database-isolation.test.cjs",
            "tools/test-workflow/database-lifecycle.test.cjs",
            "tools/test-workflow/runtime-data-paths.test.cjs",
        ],
    },
    "integration:event": {
        execution: "parallel",
        tests: [
            "tools/carnival_rewards.test.cjs",
            "tools/raid_event_master.test.cjs",
            "tools/raid_event_overall_rewards.test.cjs",
            "tools/raid_event_state.test.cjs",
            "tools/raid_event_summary.test.cjs",
            "tools/raid_event_summary_route.test.cjs",
            "tools/rush_event_shop.test.cjs",
            "tools/rush_event_shop_route.test.cjs",
            "tools/score_attack_route_transaction.test.cjs",
        ],
    },
    "integration:mission": {
        execution: "parallel",
        tests: [
            "tools/character_awake_battle_tracker.test.cjs",
            "tools/character_awake_facts.test.cjs",
            "tools/character_awake_route.test.cjs",
            "tools/character_awake_settlement.test.cjs",
            "tools/character_awake_unlock.test.cjs",
            "tools/mission_battle_facts.test.cjs",
            "tools/mission_auto_settlement_route.test.cjs",
            "tools/mission_collect_progress.test.cjs",
            "tools/mission_daily_battle_facts.test.cjs",
            "tools/mission_degree_progress.test.cjs",
            "tools/mission_event_battle_facts.test.cjs",
            "tools/mission_event_progress.test.cjs",
            "tools/mission_active_content.test.cjs",
            "tools/mission_active_core.test.cjs",
            "tools/active_mission_counter_storage.test.cjs",
            "tools/party_action_counter.test.cjs",
            "tools/expod_inject_exp_route.test.cjs",
            "tools/active_mission_reconciliation.test.cjs",
            "tools/active_mission_character_facts.test.cjs",
            "tools/active_mission_battle_facts.test.cjs",
            "tools/active_mission_chapter_facts.test.cjs",
            "tools/active_mission_quest_challenge.test.cjs",
            "tools/active_mission_specific_party_facts.test.cjs",
            "tools/active_mission_conditional_battle_facts.test.cjs",
            "tools/active_mission_specific_battle_facts.test.cjs",
            "tools/active_mission_receive_route.test.cjs",
            "tools/contents_guide_start_route.test.cjs",
            "tools/mission_master_data.test.cjs",
            "tools/mission_pass.test.cjs",
            "tools/mission_pass_battle_facts.test.cjs",
            "tools/mission_pass_content.test.cjs",
            "tools/mission_pass_route.test.cjs",
            "tools/mission_pass_settlement.test.cjs",
            "tools/mission_progress_route.test.cjs",
            "tools/mission_regular_facts.test.cjs",
            "tools/mission_response_merge.test.cjs",
            "tools/mission_settlement.test.cjs",
            "tools/mission_storage.test.cjs",
            "tools/mission_time_utils.test.cjs",
            "tools/pass_card_route.test.cjs",
        ],
    },
    "integration:quest": {
        execution: "parallel",
        tests: [
            "tools/auto_start_stamina_stop.test.cjs",
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
            "tools/asset_mode.test.cjs",
            "tools/asset_mode_compiled_smoke.test.cjs",
            "tools/cdn_asset_import.test.cjs",
            "tools/cn_asset_route.test.cjs",
            "tools/cdn_catalog_provider.test.cjs",
            "tools/cdn_runtime_manifest.test.cjs",
            "tools/cdn_audit.test.cjs",
            "tools/cdn_files.test.cjs",
            "tools/legacy_asset_state.test.cjs",
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
    "generator:mission-event": {
        execution: "serial",
        tests: [
            "tools/mission_event_battle_rules.test.cjs",
        ],
    },
})

const quickGroups = Object.keys(TEST_GROUPS).filter(name => name.startsWith("quick:"))
const integrationGroups = Object.keys(TEST_GROUPS).filter(name => name.startsWith("integration:"))

const AGGREGATE_GROUPS = Object.freeze({
    quick: Object.freeze(quickGroups),
    integration: Object.freeze(integrationGroups),
    admin: Object.freeze(["admin"]),
    generator: Object.freeze(["generator", "generator:mission-event"]),
    full: Object.freeze([
        ...quickGroups,
        ...integrationGroups,
        "admin",
        "generator:mission-event",
    ]),
})

module.exports = {
    AGGREGATE_GROUPS,
    TEST_GROUPS,
}
