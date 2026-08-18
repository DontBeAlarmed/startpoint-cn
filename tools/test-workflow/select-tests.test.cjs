const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { AGGREGATE_GROUPS, TEST_GROUPS } = require("./groups.cjs")
const { selectTestGroups } = require("./select-tests.cjs")

test("maps representative source files to focused groups", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/session-validator.ts"]),
        ["integration:quest", "quick:quest"],
    )
    for (const file of [
        "src/lib/quest/abort-request-validation.ts",
        "src/lib/quest/entry-lifecycle.ts",
        "src/lib/quest/start-entry.ts",
    ]) {
        assert.deepEqual(
            selectTestGroups([file]),
            ["integration:quest", "integration:rules", "quick:quest"],
            file,
        )
    }
    assert.deepEqual(
        selectTestGroups(["tools/quest_session_identity.test.cjs"]),
        ["quick:quest"],
    )
    for (const file of [
        "tools/quest_entry_lifecycle.test.cjs",
        "tools/single_battle_abort_numeric_validation.test.cjs",
        "tools/single_battle_abort_validation.test.cjs",
        "tools/single_battle_identity_reads.test.cjs",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:quest"], file)
    }
    assert.deepEqual(
        selectTestGroups(["scripts/gen_mission_event_battle_rules.js"]),
        ["generator:mission-event"],
    )
    assert.deepEqual(
        selectTestGroups(["assets/mission_event_battle_rules.json"]),
        ["generator:mission-event", "integration:mission", "quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/event-battle-facts.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/coverage-audit.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/event-entry-facts.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/battle-facts.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/degree-candidates.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/facts/fact-key.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/requirements/registry.ts"]),
        ["integration:mission"],
    )
    for (const file of [
        "src/lib/mission/pass.ts",
        "src/lib/mission/periodic-session-context.ts",
        "tools/oracle/git-object-runtime.test.cjs",
        "tools/oracle/generate_mission_settlement_base.cjs",
        "tools/oracle/generate_mission_entry_load_base.cjs",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:mission"])
    }
    for (const file of [
        "src/lib/gacha.ts",
        "src/lib/gacha-reward-grant.ts",
        "src/lib/gacha-reward-legacy.ts",
    ]) {
        assert.deepEqual(
            selectTestGroups([file]),
            ["integration:reward-grant", "integration:rules", "quick:gacha"],
        )
    }
    assert.deepEqual(selectTestGroups(["src/routes/api/gacha.ts"]), ["full", "integration:reward-grant", "integration:rules", "quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/routes/api/tutorial.ts"]), ["full", "integration:quest", "integration:reward-grant", "quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/routes/api/boxGacha.ts"]), ["full", "integration:event"])
    assert.deepEqual(
        selectTestGroups(["src/lib/gacha-seed-quarantine.ts"]),
        ["quick:gacha", "quick:seed"],
    )
    assert.deepEqual(selectTestGroups(["docs/protocol/seed-verification.md"]), ["quick:seed"])
    assert.deepEqual(selectTestGroups(["src/lib/gacha-draw.ts"]), ["quick:gacha"])
    assert.deepEqual(selectTestGroups(["src/lib/sampled-log.ts"]), ["quick:workflow"])
    assert.deepEqual(
        selectTestGroups(["src/lib/hot-path-log-formatters.ts"]),
        ["quick:gacha", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest.ts"]),
        ["integration:rules", "quick:quest"],
    )
    for (const file of [
        "src/lib/event-shop-purchase.ts",
        "src/lib/shop-reward-grant.ts",
    ]) {
        assert.deepEqual(
            selectTestGroups([file]),
            ["integration:reward-grant", "integration:rules"],
        )
    }
    assert.deepEqual(
        selectTestGroups(["src/routes/api/shop.ts"]),
        ["full", "integration:reward-grant", "integration:rules"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/mail.ts"]),
        ["full", "integration:reward-grant", "integration:rules"],
    )
    for (const file of [
        "src/lib/mail-reward-grant.ts",
        "docs/systems/mail.md",
    ]) {
        assert.deepEqual(
            selectTestGroups([file]),
            ["integration:reward-grant", "integration:rules"],
            file,
        )
    }
    for (const file of [
        "tools/mail_reward_grant.test.cjs",
        "tools/mail_reward_owner.test.cjs",
    ]) assert.deepEqual(selectTestGroups([file]), ["integration:reward-grant"], file)
    for (const file of [
        "tools/mail_reward_fixture.test.cjs",
        "tools/mail_reward_rollback.test.cjs",
    ]) assert.deepEqual(selectTestGroups([file]), ["integration:rules"], file)
    assert.deepEqual(
        selectTestGroups(["tools/mail_receive_transaction.test.cjs"]),
        ["integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/data/domains/session.ts"]),
        ["full", "integration:database", "quick:workflow"],
    )
    assert.deepEqual(selectTestGroups(["src/validate_cdn.ts"]), ["quick:workflow"])
    assert.deepEqual(
        selectTestGroups(["src/content/paths.ts"]),
        ["quick:cdn", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["src/content/cdn/types.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/ios-compat.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/catalog-builder.ts"]), ["quick:cdn"])
    assert.deepEqual(
        selectTestGroups(["src/content/cdn/entity-lists-directory.ts"]),
        ["quick:cdn", "quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/content/sync/scanner.ts"]),
        ["quick:cdn", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["src/content/cdn/runtime-manifest.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/patch-graph.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/digest-cache.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/catalog.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/planner.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/audit.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/audit/runner.ts"]), ["quick:content"])
    assert.deepEqual(selectTestGroups(["tools/content_asset_audit.cjs"]), ["quick:content"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/catalog-loader.ts"]), ["integration:cdn"])
    assert.deepEqual(
        selectTestGroups(["src/content/runtime/content-snapshot.ts"]),
        ["integration:cdn", "quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/character-content.ts"]),
        ["admin", "integration:quest", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["src/content/deep-freeze.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/internal/types.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/protocol.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/asset-mode.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/asset-provider.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/ios-leiting.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/asset.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/assetInTitle.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/cdnFiles.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/httpRange.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/msgpack.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/versionCheck.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/lib/version.ts"]), ["full"])
    assert.deepEqual(
        selectTestGroups(["src/routes/cn/load.ts"]),
        ["full", "integration:mission", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/raidEvent.ts"]),
        ["full", "integration:event", "integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/party.ts"]),
        ["full", "integration:mission", "integration:party"],
    )
    assert.deepEqual(
        selectTestGroups(["src/data/domains/event_mission_entry_facts.ts"]),
        ["full", "integration:database", "integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/cn-server.ts"]),
        [
            "full",
            "integration:cdn",
            "integration:database",
            "integration:multi-hub",
            "integration:runtime",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["src/runtime/capabilities.ts"]),
        ["integration:runtime", "quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["src/modes/registry.ts"]),
        ["quick:modes"],
    )
    assert.deepEqual(
        selectTestGroups(["src/content/runtime/content-repository.ts"]),
        ["quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/server.ts"]),
        ["full", "integration:cdn", "integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/data/index.ts"]),
        ["full", "integration:database"],
    )
    assert.deepEqual(selectTestGroups(["src/data/player-save/v2.ts"]), ["integration:database"])
    assert.deepEqual(selectTestGroups(["src/data/defaultSave.ts"]), ["integration:database"])
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/active-quest-service.ts"]),
        ["integration:quest", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/story-join-character.ts"]),
        ["integration:quest", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["docs/systems/save-validation.md"]), ["integration:database"])
    assert.deepEqual(
        selectTestGroups(["src/runtime/data-paths.ts"]),
        ["integration:database", "quick:cdn", "quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/web_api/seeds.ts"]),
        ["admin", "integration:database", "quick:seed"],
    )
    assert.deepEqual(
        selectTestGroups(["src/runtime/lifecycle.ts"]),
        ["integration:multi-hub", "integration:runtime", "quick:runtime"],
    )
    assert.deepEqual(selectTestGroups(["tools/server-bundle/build.cjs"]), ["quick:runtime"])
    assert.deepEqual(selectTestGroups(["tools/server-bundle/verify.cjs"]), ["quick:runtime"])
    assert.deepEqual(selectTestGroups(["docs/runtime/server-bundle.md"]), ["quick:runtime"])
    assert.deepEqual(
        selectTestGroups(["src/content/startup/bootstrap.ts"]),
        ["integration:runtime", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["src/content/sync/entry.ts"]), ["quick:content"])
    assert.deepEqual(
        selectTestGroups(["src/multi/tcp/server.ts"]),
        ["integration:multi-hub", "integration:runtime", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/coordinator/contracts.ts"]),
        ["integration:multi-hub", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/coordinator/embedded.ts"]),
        ["integration:multi-hub", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/http/context.ts"]),
        ["integration:multi-hub", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/admission/registry.ts"]),
        ["integration:multi-hub", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/snapshot/player-snapshot.ts"]),
        ["integration:multi-hub", "quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_coordinator_contract.test.cjs"]),
        ["quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_coordinator_embedded.test.cjs"]),
        ["quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_room_identity.test.cjs"]),
        ["quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["assets/server/npc_contributor_names.json"]),
        ["quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/npc_contributor_names.cjs"]),
        ["quick:protocol"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/npc_contributor_names.test.cjs"]),
        ["quick:protocol"],
    )
    assert.deepEqual(selectTestGroups(["tools/perf/hub_baseline.cjs"]), ["integration:multi-hub"])
    assert.deepEqual(selectTestGroups(["tools/perf/hub_baseline_helpers.cjs"]), ["integration:multi-hub"])
    assert.deepEqual(selectTestGroups(["tools/perf/hub_baseline.test.cjs"]), ["integration:multi-hub"])
    assert.deepEqual(selectTestGroups(["admin/src/App.tsx"]), ["admin"])
})

test("keeps unknown content files on the full suite", () => {
    assert.deepEqual(selectTestGroups(["src/content/repository.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/content/build/manifest.ts"]), ["full"])
})

test("selects the registered group before applying workflow path rules", () => {
    assert.deepEqual(
        selectTestGroups(["tools/test-workflow/database-isolation.test.cjs"]),
        ["integration:database"],
    )
})

test("accumulates every directly related source group", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/degree-session-context.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/degree-content-tables.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/degree-immutable.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/helpers/mission-degree-session-fixture.cjs"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/host-finish-persistence.ts"]),
        ["integration:quest", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/awake-unlock.ts"]),
        ["integration:mission", "integration:mission-compiled"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/web_api/server.ts"]),
        ["admin", "integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/singleBattleQuest.ts"]),
        [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "integration:rules",
            "quick:quest",
        ],
    )
})

test("selects quest and mission regressions for the single battle route", () => {
    const groups = selectTestGroups(["src/routes/api/singleBattleQuest.ts"])
    assert.deepEqual(groups, [
        "integration:compiled",
        "integration:mission",
        "integration:quest",
        "integration:rules",
        "quick:quest",
    ])
    assert.ok(
        groups.flatMap(group => TEST_GROUPS[group].tests)
            .includes("tools/mission_auto_settlement_route.test.cjs"),
    )
    assert.ok(
        TEST_GROUPS["integration:quest"].tests
            .includes("tools/perf/single_battle_settlement_baseline.test.cjs"),
    )
    assert.ok(
        TEST_GROUPS["integration:quest"].tests
            .includes("tools/perf/single_battle_settlement_admission.test.cjs"),
    )
    assert.ok(
        TEST_GROUPS["integration:rules"].tests
            .includes("tools/single_continue_route.test.cjs"),
    )
})

test("maps single finish settlement implementation and regression precisely", () => {
    assert.deepEqual(
        selectTestGroups(["src/routes/api/singleBattleQuest.ts"]),
        [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "integration:rules",
            "quick:quest",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/single-finish-settlement.ts"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/single-orchestrator.ts"]),
        ["integration:mission", "integration:quest", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/single-settlement-writes.ts"]),
        [
            "integration:compiled",
            "integration:event",
            "integration:mission",
            "integration:quest",
            "integration:reward-grant",
            "quick:modes",
            "quick:quest",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/single-settlement-response-state.ts"]),
        [
            "integration:compiled",
            "integration:event",
            "integration:mission",
            "integration:quest",
            "integration:reward-grant",
            "quick:modes",
            "quick:quest",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/single-response-projector.ts"]),
        [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "quick:content",
            "quick:quest",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_battle_finish_validation.test.cjs"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_finish_authority_transaction.test.cjs"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_finish_final_projection.test.cjs"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/single-mission-settlement.ts"]),
        ["integration:mission", "integration:quest", "integration:reward-grant", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/settlement.ts"]),
        ["integration:mission", "integration:reward-grant"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/settlement-write.ts"]),
        ["integration:mission", "integration:reward-grant"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_finish_orchestrator_architecture.test.cjs"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_finish_response_projector.test.cjs"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/single-finish-validation.ts"]),
        ["integration:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_finish_request_validation.test.cjs"]),
        ["integration:quest"],
    )
})

test("maps single continue lifecycle implementation and regression precisely", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/single-continue-lifecycle.ts"]),
        ["integration:quest", "integration:rules", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_continue_lifecycle.test.cjs"]),
        ["quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_continue_idempotency.test.cjs"]),
        ["quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/helpers/single-continue-fixture.cjs"]),
        ["integration:quest", "integration:rules", "quick:quest"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/api/singleBattleQuest.ts"]),
        [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "integration:rules",
            "quick:quest",
        ],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_continue_route.test.cjs"]),
        ["integration:rules"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/single_continue_route_errors.test.cjs"]),
        ["integration:rules"],
    )
    assert.equal(
        selectTestGroups([
            "src/lib/quest/single-continue-lifecycle.ts",
            "src/routes/api/singleBattleQuest.ts",
            "tools/helpers/single-continue-fixture.cjs",
            "tools/single_continue_idempotency.test.cjs",
            "tools/single_continue_lifecycle.test.cjs",
            "tools/single_continue_route.test.cjs",
            "tools/single_continue_route_errors.test.cjs",
        ]).some(group => group.includes("multi")),
        false,
    )
})

test("maps the public reward grant layer and its regressions to one focused leaf", () => {
    const group = "integration:reward-grant"
    const tests = [
        "tools/reward_grant_plan.test.cjs",
        "tools/reward_grant_executor.test.cjs",
        "tools/reward_grant_architecture.test.cjs",
        "tools/score_reward_selection_core.test.cjs",
        "tools/score_reward_selection.test.cjs",
        "tools/single_settlement_reward_grant.test.cjs",
        "tools/task23c_reward_grants.test.cjs",
        "tools/shop_reward_grant.test.cjs",
        "tools/mail_reward_grant.test.cjs",
        "tools/mail_reward_owner.test.cjs",
    ]

    assert.deepEqual(TEST_GROUPS[group], {
        execution: "serial",
        timeoutMs: 60_000,
        tests,
    })
    for (const file of [
        "src/lib/reward-grant/types.ts",
        "src/lib/reward-grant/plan.ts",
        "src/lib/reward-grant/executor.ts",
        "src/lib/reward-grant/index.ts",
        "docs/systems/reward-grant-transactions.md",
        ...tests,
    ]) {
        assert.deepEqual(selectTestGroups([file]), [group], file)
    }
})

test("maps single settlement reward grants to the focused reward grant leaf", () => {
    const expectedGroups = ["integration:reward-grant"]
    const adapter = "src/lib/quest/finish/single-settlement-reward-grant.ts"
    const regression = "tools/single_settlement_reward_grant.test.cjs"

    assert.deepEqual(selectTestGroups([adapter]), expectedGroups)
    assert.deepEqual(selectTestGroups([regression]), expectedGroups)
    assert.ok(TEST_GROUPS[expectedGroups[0]].tests.includes(regression))
})

test("maps Task23c reward domains and its real regression to precise groups", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/grants.ts"]),
        ["integration:mission", "integration:reward-grant"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/carnival-rewards.ts"]),
        ["integration:event", "integration:reward-grant"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/task23c_reward_grants.test.cjs"]),
        ["integration:reward-grant"],
    )
    assert.ok(TEST_GROUPS["integration:reward-grant"].tests.includes(
        "tools/task23c_reward_grants.test.cjs",
    ))
})

test("maps score reward selection and projection to every affected leaf", () => {
    const sourceGroups = ["integration:reward-grant", "integration:rules", "quick:quest"]

    for (const file of [
        "src/lib/quest/score-reward-normalization.ts",
        "src/lib/quest/score-reward-projection.ts",
        "src/lib/quest/score-reward-selection-core.ts",
        "src/lib/quest/score-reward-selection.ts",
        "src/lib/quest/score-reward-settlement.ts",
        "docs/systems/quest-score-rewards.md",
    ]) {
        assert.deepEqual(selectTestGroups([file]), sourceGroups, file)
    }
    assert.deepEqual(
        selectTestGroups(["tools/score_reward_selection_core.test.cjs"]),
        ["integration:reward-grant"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/score_reward_selection.test.cjs"]),
        ["integration:reward-grant"],
    )
})

test("maps the single battle settlement baseline family to integration quest", () => {
    for (const file of [
        "tools/perf/single_battle_settlement_admission.cjs",
        "tools/perf/single_battle_settlement_admission.test.cjs",
        "tools/perf/single_battle_settlement_baseline.cjs",
        "tools/perf/single_battle_settlement_baseline.test.cjs",
        "tools/perf/single_battle_settlement_fixture.cjs",
        "tools/perf/single_battle_settlement_harness.cjs",
        "tools/perf/single_battle_settlement_request_runner.cjs",
        "tools/perf/single_battle_settlement_time.cjs",
        "tools/perf/single_battle_settlement_scenario_helpers.cjs",
        "tools/perf/single_battle_settlement_lifecycle_scenarios.cjs",
        "tools/perf/single_battle_settlement_finish_scenarios.cjs",
        "tools/perf/single_battle_settlement_scenarios.cjs",
        "tools/perf/__snapshots__/single_battle_settlement_baseline.json",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:quest"], file)
    }
})

test("upgrades package and unknown source changes to full", () => {
    assert.deepEqual(selectTestGroups(["package.json"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/unmapped/new-feature.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/lib/character.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["tools/test-workflow/groups.cjs"]), ["full"])
})

test("selects mission regressions for awake finish settlement wiring", () => {
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/awake-settlement.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/awake-unlock-response.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/degree-context-requirements.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/index.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/lib/quest/finish/party-co-clear-tracker.ts"]),
        ["integration:mission"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/http/battle.ts"]),
        ["integration:mission", "integration:multi-hub", "quick:protocol"],
    )
})

test("deduplicates and stably sorts selected groups", () => {
    assert.deepEqual(
        selectTestGroups([
            "src/lib/gacha.ts",
            "admin/src/App.tsx",
            "src/lib/quest/host-finish-persistence.ts",
            "src/lib/gacha.ts",
        ]),
        [
            "admin",
            "integration:quest",
            "integration:reward-grant",
            "integration:rules",
            "quick:gacha",
            "quick:quest",
        ],
    )
})

test("generator aggregate includes both leaves while full only adds the self-contained leaf", () => {
    assert.deepEqual(
        AGGREGATE_GROUPS.generator,
        ["generator", "generator:mission-event"],
    )
    assert.deepEqual(
        AGGREGATE_GROUPS.full,
        [
            ...AGGREGATE_GROUPS.quick,
            ...AGGREGATE_GROUPS.integration,
            "admin",
            "generator:mission-event",
        ],
    )
    assert.equal(AGGREGATE_GROUPS.full.includes("generator"), false)
    assert.equal(AGGREGATE_GROUPS.full.includes("generator:mission-event"), true)
    assert.deepEqual(TEST_GROUPS["integration:cdn"].tests, [
        "tools/asset_mode.test.cjs",
        "tools/asset_mode_compiled_smoke.test.cjs",
        "tools/cdn_asset_import.test.cjs",
        "tools/cn_asset_route.test.cjs",
        "tools/cdn_catalog_provider.test.cjs",
        "tools/cdn_runtime_manifest.test.cjs",
        "tools/cdn_audit.test.cjs",
        "tools/cdn_files.test.cjs",
        "tools/ios_asset_route.test.cjs",
        "tools/combined_startup.test.cjs",
        "tools/ios_leiting_route.test.cjs",
        "tools/version_dis_android.test.cjs",
        "tools/legacy_asset_state.test.cjs",
    ])
})

test("registers strict event battle generation separately from runtime facts", () => {
    assert.deepEqual(TEST_GROUPS["generator:mission-event"], {
        execution: "serial",
        tests: ["tools/mission_event_battle_rules.test.cjs"],
    })
    assert.equal(TEST_GROUPS.generator.tests.includes(
        "tools/mission_event_battle_rules.test.cjs",
    ), false)
    assert.equal(
        TEST_GROUPS["integration:mission"].tests.includes("tools/mission_event_battle_facts.test.cjs"),
        true,
    )
    assert.equal(
        TEST_GROUPS["integration:mission"].tests.includes("tools/mission_coverage_audit.test.cjs"),
        true,
    )
})

test("registers mission fact requirements in the mission integration suite", () => {
    assert.equal(
        TEST_GROUPS["integration:mission"].tests.includes(
            "tools/mission_fact_requirements.test.cjs",
        ),
        true,
    )
    assert.deepEqual(
        selectTestGroups(["tools/mission_fact_requirements.test.cjs"]),
        ["integration:mission"],
    )
})

test("registers focused runtime state and socket smoke groups", () => {
    assert.deepEqual(TEST_GROUPS["quick:runtime"], {
        execution: "parallel",
        tests: [
            "tools/server_bundle.test.cjs",
            "tools/server_bundle_zip.test.cjs",
            "tools/runtime_pack.test.cjs",
            "tools/runtime_bundle_metadata.test.cjs",
            "tools/runtime_config.test.cjs",
            "tools/ios_runtime_config.test.cjs",
            "tools/multi_hub_credentials.test.cjs",
            "tools/multi_hub_authentication.test.cjs",
            "tools/multi_hub_cli_env.test.cjs",
            "tools/multi_management_service.test.cjs",
            "tools/multi_management_routes.test.cjs",
            "tools/multi_hub_control.test.cjs",
            "tools/multi_hub_idempotency.test.cjs",
            "tools/multi_hub_session_cleanup.test.cjs",
            "tools/multi_hub_token.test.cjs",
            "tools/multi_runtime_config.test.cjs",
            "tools/multi_client_fallback.test.cjs",
            "tools/comic_route.test.cjs",
            "tools/admin_server_status_runtime_config.test.cjs",
            "tools/cn_tool_capabilities.test.cjs",
            "tools/runtime_admin.test.cjs",
            "tools/admin_multi_status.test.cjs",
            "tools/runtime_health.test.cjs",
            "tools/runtime_lifecycle.test.cjs",
            "tools/runtime_native_binding.test.cjs",
            "tools/server_time_service.test.cjs",
            "tools/server_time_routes.test.cjs",
            "tools/runtime_capabilities.test.cjs",
            "tools/runtime_capabilities_wiring.test.cjs",
        ],
    })
    assert.deepEqual(
        selectTestGroups(["tools/server_time_routes.test.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_hub_cli_env.test.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_management_service.test.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_management_routes.test.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/multi_client_fallback.test.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(TEST_GROUPS["integration:runtime"], {
        execution: "serial",
        timeoutMs: 360_000,
        tests: ["tools/runtime_compiled_smoke.test.cjs"],
    })
})

test("routes multiplayer management adapters to the runtime regressions", () => {
    assert.deepEqual(
        selectTestGroups(["src/multi/management/offline.ts"]),
        ["integration:multi-hub", "quick:protocol", "quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["src/routes/web_api/multi-management.ts"]),
        ["admin", "integration:database", "quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/manage_multi_hub_token.cjs"]),
        ["quick:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/lib/multi-hub-env.cjs"]),
        ["quick:runtime"],
    )
})

test("registers the trusted multi-hub process suite as a bounded serial group", () => {
    assert.deepEqual(TEST_GROUPS["integration:multi-hub"], {
        execution: "serial",
        timeoutMs: 240_000,
        tests: [
            "tests/multi-hub-process-harness.test.js",
            "tests/multi-hub-process.test.js",
            "tools/perf/hub_baseline.test.cjs",
        ],
    })
    assert.deepEqual(
        selectTestGroups(["tests/multi-hub-process-harness.test.js"]),
        ["integration:multi-hub"],
    )
    assert.deepEqual(
        selectTestGroups(["tests/multi-hub-process.test.js"]),
        ["integration:multi-hub"],
    )
    assert.deepEqual(
        selectTestGroups(["tests/helpers/multi-hub-process-harness.js"]),
        ["integration:multi-hub"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/fixtures/multi-hub/README.md"]),
        ["integration:multi-hub"],
    )
})

test("routes multiplayer runtime and private credential changes to focused groups", () => {
    for (const source of [
        "src/multi/hub/authentication-rejections.ts",
        "src/multi/hub/credential-reloader.ts",
        "src/multi/hub/token.ts",
        "src/multi/hub/credential-store.ts",
        "src/multi/hub/control-routes.ts",
        "src/multi/hub/node-sessions.ts",
        "src/multi/runtime/service.ts",
        "src/multi/runtime/status.ts",
    ]) {
        assert.deepEqual(
            selectTestGroups([source]),
            ["integration:multi-hub", "quick:protocol", "quick:runtime"],
            source,
        )
    }
    assert.deepEqual(
        selectTestGroups(["tools/multi_hub_authentication.test.cjs"]),
        ["integration:multi-hub", "quick:protocol", "quick:runtime"],
    )
})

test("registers focused seed state and API regressions", () => {
    assert.deepEqual(TEST_GROUPS["quick:seed"], {
        execution: "parallel",
        tests: [
            "tools/gacha_faithful_inspect.test.cjs",
            "tools/gacha_seed_catalog_builder.test.cjs",
            "tools/gacha_seed_catalog_cli.test.cjs",
            "tools/gacha_seed_quarantine.test.cjs",
            "tools/seed_api.test.cjs",
        ],
    })
    assert.deepEqual(selectTestGroups(["tools/seed_api.test.cjs"]), ["quick:seed"])
})

test("registers the focused CDN path contract", () => {
    assert.deepEqual(TEST_GROUPS["quick:cdn"], {
        execution: "parallel",
        tests: [
            "tools/cdn_catalog.test.cjs",
            "tools/cdn_archive_sources.test.cjs",
            "tools/cdn_patch_manifest.test.cjs",
            "tools/cdn_patch_overlay.test.cjs",
            "tools/cdn_patch_check.test.cjs",
            "tools/admin_content_status.test.cjs",
            "tools/cdn_paths.test.cjs",
            "tools/cdn_planner.test.cjs",
            "tools/cdn_types.test.cjs",
        ],
    })
    assert.deepEqual(selectTestGroups(["tools/cdn_catalog.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/archive-sources.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/patch-manifest.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/patch-overlay.ts"]), ["quick:cdn", "quick:content"])
    assert.deepEqual(selectTestGroups(["tools/cdn_paths.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_planner.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_types.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_catalog_provider.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_audit.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_runtime_manifest.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_files.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/ios_asset_route.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/audit_cdn_catalog.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["docs/cdn/catalog-planner.md"]), ["integration:cdn"])
    assert.deepEqual(
        selectTestGroups(["tools/content_sync_smoke.cjs"]),
        ["integration:content"],
    )
    assert.deepEqual(
        selectTestGroups(["docs/cdn/content-sync.md"]),
        ["integration:cdn", "integration:content"],
    )
    assert.deepEqual(selectTestGroups(["tools/cdn_asset_import.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cn_asset_route.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/asset_mode.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(
        selectTestGroups(["tools/asset_mode_compiled_smoke.test.cjs"]),
        ["integration:cdn"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/content_snapshot_configuration.test.cjs"]),
        ["quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/content_sync_entry.test.cjs"]),
        ["quick:content"],
    )
})

test("registers the iOS asset route regression in the CDN group", () => {
    assert.ok(TEST_GROUPS["integration:cdn"].tests.includes("tools/ios_asset_route.test.cjs"))
})

test("registers every test in exactly one leaf group and full covers runtime regressions", () => {
    function findTests(directory) {
        return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) return findTests(entryPath)
            return /\.test\.(?:cjs|js)$/.test(entry.name)
                ? [entryPath.replaceAll(path.sep, "/")]
                : []
        })
    }

    const allTests = [...findTests("tests"), ...findTests("tools")].sort()
    const leafMembership = new Map()
    for (const [group, definition] of Object.entries(TEST_GROUPS)) {
        for (const file of definition.tests) {
            const groups = leafMembership.get(file) ?? []
            groups.push(group)
            leafMembership.set(file, groups)
        }
    }

    assert.ok(allTests.length >= 42)
    for (const file of allTests) {
        if (file === "tools/multi_hub_authentication.test.cjs") {
            assert.deepEqual(leafMembership.get(file), ["quick:runtime"], file)
            continue
        }
        assert.deepEqual(leafMembership.get(file), [selectTestGroups([file])[0]], file)
    }

    const externalGeneratorTests = new Set(TEST_GROUPS.generator.tests)
    const fullExpectedTests = allTests.filter(file => !externalGeneratorTests.has(file))
    const fullTests = AGGREGATE_GROUPS.full
        .flatMap(group => TEST_GROUPS[group].tests)
        .sort()
    assert.deepEqual(fullTests, fullExpectedTests)

    const externalDataMarkers = [
        ["wf-assets", "-cn"].join(""),
        ["--git-common", "-dir"].join(""),
        ["direct", "WorkspaceRoot"].join(""),
        ["world", "FlipperRoot"].join(""),
        ["RAW", "_ROOT"].join(""),
    ]
    for (const file of fullTests) {
        const source = fs.readFileSync(file, "utf8")
        for (const marker of externalDataMarkers) {
            assert.equal(source.includes(marker), false, `${file}: ${marker}`)
        }
    }
})

test("registers mission catalog and fact store regressions in the mission leaf group", () => {
    assert.deepEqual(selectTestGroups(["tools/mission_catalog.test.cjs"]), ["integration:mission"])
    assert.ok(TEST_GROUPS["integration:mission"].tests.includes("tools/mission_catalog.test.cjs"))
    assert.deepEqual(selectTestGroups(["tools/mission_catalog_wrappers.test.cjs"]), ["integration:mission"])
    assert.ok(TEST_GROUPS["integration:mission"].tests.includes("tools/mission_catalog_wrappers.test.cjs"))
    assert.deepEqual(selectTestGroups(["tools/mission_fact_key.test.cjs"]), ["integration:mission"])
    assert.ok(TEST_GROUPS["integration:mission"].tests.includes("tools/mission_fact_key.test.cjs"))
    for (const file of [
        "tools/mission_collected_items_batch.test.cjs",
        "tools/mission_collect_legacy_context.test.cjs",
        "tools/mission_collect_session_equivalence.test.cjs",
        "tools/mission_collect_session_invariant.test.cjs",
        "tools/mission_collect_session_scope.test.cjs",
        "tools/mission_collect_session_settlement.test.cjs",
        "tools/mission_evaluation_production_loaders.test.cjs",
        "tools/mission_shop_purchases_fact_loader.test.cjs",
        "tools/mission_evaluation_quest_scoped.test.cjs",
        "tools/mission_evaluation_session.test.cjs",
        "tools/mission_master_value.test.cjs",
        "tools/mission_periodic_session_migration.test.cjs",
        "tools/mission_regular_session_equivalence.test.cjs",
        "tools/mission_regular_session_scope.test.cjs",
        "tools/mission_regular_session_settlement.test.cjs",
        "tools/mission_regular_state_derivation.test.cjs",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:mission"])
        assert.ok(TEST_GROUPS["integration:mission"].tests.includes(file))
    }
    for (const file of [
        "src/data/domains/item.ts",
        "src/data/domains/shopPurchase.ts",
        "src/lib/mission/category-session-plan.ts",
        "src/lib/mission/collect-progress.ts",
        "src/lib/mission/collect-session-context.ts",
        "src/lib/mission/master-value.ts",
        "src/lib/mission/mission-catalog-source.ts",
        "src/lib/mission/mission-catalog.ts",
        "src/lib/mission/regular-session-context.ts",
    ]) {
        assert.ok(selectTestGroups([file]).includes("integration:mission"), file)
    }
    for (const file of [
        "tools/helpers/mission-evaluation-rejected-observer-worker.cjs",
        "tools/helpers/mission-evaluation-rejected-promise-worker.cjs",
        "tools/helpers/mission-evaluation-session-fixture.cjs",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:mission"])
    }
    assert.deepEqual(
        selectTestGroups(["src/lib/mission/evaluation-session.ts"]),
        ["integration:mission"],
    )
})

test("routes focused mission performance admission files to the mission group", () => {
    for (const file of [
        "tools/perf/mission_engine_focused_admission.cjs",
        "tools/perf/mission_engine_focused_admission.test.cjs",
        "tools/perf/mission_engine_focused_baseline.cjs",
        "tools/perf/mission_engine_focused_report.cjs",
        "tools/perf/mission_engine_focused_runner.test.cjs",
        "tools/perf/__snapshots__/mission_engine_focused_baseline.json",
    ]) {
        assert.deepEqual(selectTestGroups([file]), ["integration:mission"], file)
    }
})

test("keeps external data concerns out of self-contained runtime tests", () => {
    const runtimeTests = [
        "tools/score_attack_event.test.cjs",
        "tools/treasure_key_entry.test.cjs",
    ]
    const forbiddenMarkers = [
        "orderedmap",
        "fieldMap",
        "converterSource",
        ["wf-assets", "-cn"].join(""),
        ["git", "CommonDirectory"].join(""),
    ]

    for (const file of runtimeTests) {
        const source = fs.readFileSync(file, "utf8")
        for (const marker of forbiddenMarkers) {
            assert.equal(source.includes(marker), false, `${file}: ${marker}`)
        }
    }
})

test("keeps runtime wiring contracts in full instead of generator", () => {
    const contracts = [
        {
            data: "tools/score_attack_event_data.test.cjs",
            markers: ["src/lib/quest/finish/single-response-projector.ts", "scoreAttackEventData"],
            runtime: "tools/score_attack_event.test.cjs",
        },
        {
            data: "tools/treasure_key_entry_data.test.cjs",
            markers: [
                "src/lib/quest/active-quest-service.ts",
                "insertActiveQuestSource",
                "quest start response must include the post-deduction item_list",
            ],
            runtime: "tools/treasure_key_entry.test.cjs",
        },
    ]

    for (const contract of contracts) {
        const runtimeSource = fs.readFileSync(contract.runtime, "utf8")
        const dataSource = fs.readFileSync(contract.data, "utf8")
        for (const marker of contract.markers) {
            assert.equal(runtimeSource.includes(marker), true, `${contract.runtime}: ${marker}`)
            assert.equal(dataSource.includes(marker), false, `${contract.data}: ${marker}`)
        }
    }
})

test("guards missing active quest persistence calls before comparing order", () => {
    const source = fs.readFileSync("tools/treasure_key_entry.test.cjs", "utf8")
    assert.match(source, /const persistIndex\s*=\s*insertActiveQuestSource\.indexOf/)
    assert.match(source, /const publishIndex\s*=\s*insertActiveQuestSource\.indexOf/)
    assert.match(source, /assert\.ok\(persistIndex\s*>=\s*0/)
    assert.match(source, /assert\.ok\(publishIndex\s*>=\s*0/)
    assert.match(source, /assert\.ok\(\s*persistIndex\s*<\s*publishIndex/)
})

test("keeps isolated test groups parallel while infrastructure groups stay serial", () => {
    for (const group of AGGREGATE_GROUPS.quick) {
        assert.equal(TEST_GROUPS[group].execution, "parallel")
    }
    assert.equal(TEST_GROUPS["integration:compiled"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:runtime"].execution, "serial")
    assert.equal(TEST_GROUPS["integration:mission-compiled"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:rules"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:database"].execution, "serial")
    assert.equal(TEST_GROUPS["integration:event"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:mission"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:mission"].timeoutMs, 60_000)
    assert.equal(TEST_GROUPS["integration:party"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:quest"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:quest"].timeoutMs, 60_000)
    assert.equal(TEST_GROUPS["integration:cdn"].execution, "serial")
})

test("splits isolated integration tests into focused domains", () => {
    assert.deepEqual(TEST_GROUPS["integration:database"].tests, [
        "tools/admin_player_actions.test.cjs",
        "tools/history_receive_route.test.cjs",
        "tools/mail_receive_transaction.test.cjs",
        "tools/player_history_profile_route.test.cjs",
        "tools/player_save_v2.test.cjs",
        "tools/server_gameplay_settings.test.cjs",
        "tools/shop_purchase_period_storage.test.cjs",
        "tools/test-workflow/database-isolation.test.cjs",
        "tools/test-workflow/database-lifecycle.test.cjs",
        "tools/test-workflow/runtime-data-paths.test.cjs",
        "tools/stamina_serialization.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:event"].tests, [
        "tools/box_gacha_exec_transaction.test.cjs",
        "tools/carnival_rewards.test.cjs",
        "tools/event_route_reachability.test.cjs",
        "tools/how_to_get_route.test.cjs",
        "tools/practice_battle_history.test.cjs",
        "tools/practice_battle_history_route.test.cjs",
        "tools/raid_event_master.test.cjs",
        "tools/raid_event_overall_rewards.test.cjs",
        "tools/raid_event_state.test.cjs",
        "tools/raid_event_summary.test.cjs",
        "tools/raid_event_summary_route.test.cjs",
        "tools/ranking_event_route.test.cjs",
        "tools/rush_event_battle_flow.test.cjs",
        "tools/rush_event_shop.test.cjs",
        "tools/rush_event_shop_route.test.cjs",
        "tools/rush_event_reset_route.test.cjs",
        "tools/shop_campaign_lineup.test.cjs",
        "tools/score_attack_history.test.cjs",
        "tools/score_attack_history_route.test.cjs",
        "tools/score_attack_route_transaction.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:mission"].tests, [
        "tools/character_awake_battle_tracker.test.cjs",
        "tools/character_awake_facts.test.cjs",
        "tools/character_awake_route.test.cjs",
        "tools/character_awake_settlement.test.cjs",
        "tools/character_awake_unlock.test.cjs",
        "tools/mission_awake_evaluation_settlement.test.cjs",
        "tools/mission_awake_reward_owner.test.cjs",
        "tools/mission_awake_session.test.cjs",
        "tools/character_election_route.test.cjs",
        "tools/mission_battle_facts.test.cjs",
        "tools/mission_auto_settlement_route.test.cjs",
        "tools/mission_get_progress_transaction.test.cjs",
        "tools/mission_progress_stage_b.test.cjs",
        "tools/mission_progress_stage_b_route.test.cjs",
        "tools/mission_progress_stage_b_integration.test.cjs",
        "tools/mission_reward_invalidation.test.cjs",
        "tools/mission_reward_invalidation_integration.test.cjs",
        "tools/mission_collect_progress.test.cjs",
        "tools/mission-client-check-diagnostics.test.cjs",
        "tools/mission_coverage_audit.test.cjs",
        "tools/mission_daily_battle_facts.test.cjs",
        "tools/mission_degree_candidates.test.cjs",
        "tools/mission_degree_characterization.test.cjs",
        "tools/mission_degree_content_cache.test.cjs",
        "tools/mission_degree_content_tables.test.cjs",
        "tools/mission_degree_context_scope.test.cjs",
        "tools/mission_degree_custom_catalog.test.cjs",
        "tools/mission_degree_immutable.test.cjs",
        "tools/mission_degree_oracle_independence.test.cjs",
        "tools/mission_degree_progress.test.cjs",
        "tools/mission_degree_session_context.test.cjs",
        "tools/mission_degree_session_selection.test.cjs",
        "tools/mission_degree_settlement_session.test.cjs",
        "tools/mission_degree_settlement_semantics.test.cjs",
        "tools/mission_degree_settlement_failure.test.cjs",
        "tools/mission_degree_second_board_scope.test.cjs",
        "tools/mission_event_battle_facts.test.cjs",
        "tools/mission_event_current_state.test.cjs",
        "tools/mission_event_immutable.test.cjs",
        "tools/mission_event_entry_facts.test.cjs",
        "tools/mission_raid_set_party_route.test.cjs",
        "tools/mission_event_login_route.test.cjs",
        "tools/mission_event_oracle_independence.test.cjs",
        "tools/mission_event_progress.test.cjs",
        "tools/mission_event_session_scope.test.cjs",
        "tools/mission_event_session_semantics.test.cjs",
        "tools/mission_event_session_settlement.test.cjs",
        "tools/mission_collected_items_batch.test.cjs",
        "tools/mission_collect_legacy_context.test.cjs",
        "tools/mission_collect_session_equivalence.test.cjs",
        "tools/mission_collect_session_invariant.test.cjs",
        "tools/mission_collect_session_scope.test.cjs",
        "tools/mission_collect_session_settlement.test.cjs",
        "tools/mission_evaluation_production_loaders.test.cjs",
        "tools/mission_shop_purchases_fact_loader.test.cjs",
        "tools/mission_evaluation_quest_scoped.test.cjs",
        "tools/mission_evaluation_session.test.cjs",
        "tools/mission_fact_key.test.cjs",
        "tools/mission_fact_requirements.test.cjs",
        "tools/mission_master_value.test.cjs",
        "tools/mission_raid_summary_route.test.cjs",
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
        "tools/mission_catalog.test.cjs",
        "tools/mission_catalog_wrappers.test.cjs",
        "tools/mission_master_data.test.cjs",
        "tools/mission_pass.test.cjs",
        "tools/mission_pass_battle_facts.test.cjs",
        "tools/mission_pass_content.test.cjs",
        "tools/mission_pass_route.test.cjs",
        "tools/mission_pass_settlement.test.cjs",
        "tools/pass_card_point_change.test.cjs",
        "tools/mission_periodic_session_migration.test.cjs",
        "tools/mission_progress_route.test.cjs",
        "tools/mission_regular_facts.test.cjs",
        "tools/mission_regular_session_equivalence.test.cjs",
        "tools/mission_regular_session_scope.test.cjs",
        "tools/mission_regular_session_settlement.test.cjs",
        "tools/mission_regular_state_derivation.test.cjs",
        "tools/mission_response_merge.test.cjs",
        "tools/perf/mission_engine_focused_admission.test.cjs",
        "tools/perf/mission_engine_focused_baseline.test.cjs",
        "tools/perf/mission_engine_focused_runner.test.cjs",
        "tools/perf/mission_entry_base_oracle.test.cjs",
        "tools/perf/mission_entry_layered_load.test.cjs",
        "tools/perf/mission_entry_load_metrics.test.cjs",
        "tools/perf/mission_settlement_baseline.test.cjs",
        "tools/oracle/git-object-runtime.test.cjs",
        "tools/mission_settlement_base_oracle.test.cjs",
        "tools/mission_settlement_evaluate.test.cjs",
        "tools/mission_settlement_pipeline_characterization.test.cjs",
        "tools/mission_settlement_pipeline_interfaces.test.cjs",
        "tools/mission_settlement_pipeline_rollback.test.cjs",
        "tools/mission_settlement_prepare.test.cjs",
        "tools/mission_settlement_scope.test.cjs",
        "tools/mission_settlement.test.cjs",
        "tools/mission_settlement_write.test.cjs",
        "tools/mission_storage.test.cjs",
        "tools/mission_time_utils.test.cjs",
        "tools/pass_card_purchase_route.test.cjs",
        "tools/pass_card_route.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:quest"].tests, [
        "tools/auto_start_stamina_stop.test.cjs",
        "tools/perf/single_battle_settlement_admission.test.cjs",
        "tools/perf/single_battle_settlement_baseline.test.cjs",
        "tools/quest_entry_lifecycle.test.cjs",
        "tools/single_battle_abort_numeric_validation.test.cjs",
        "tools/single_battle_abort_validation.test.cjs",
        "tools/single_battle_identity_reads.test.cjs",
        "tools/quest_host_finish.test.cjs",
        "tools/single_battle_finish_validation.test.cjs",
        "tools/single_finish_authority_transaction.test.cjs",
        "tools/single_finish_final_projection.test.cjs",
        "tools/single_finish_awake_reward_owner.test.cjs",
        "tools/single_finish_orchestrator_architecture.test.cjs",
        "tools/single_finish_response_projector.test.cjs",
        "tools/single_finish_request_validation.test.cjs",
        "tools/story_quest_finish.test.cjs",
        "tools/tutorial_update_step.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:party"].tests, [
        "tools/multi_battle_lifecycle.test.cjs",
        "tools/special_quest_party.test.cjs",
    ])
})

test("quick workflow includes documentation and package script contracts", () => {
    assert.deepEqual(TEST_GROUPS["quick:workflow"].tests, [
        "tools/architecture_dependencies.test.cjs",
        "tools/docs_check.test.cjs",
        "tools/final_operation_compatibility_docs.test.cjs",
        "tools/log_readability.test.cjs",
        "tools/sampled_log.test.cjs",
        "tools/test-workflow/benchmark.test.cjs",
        "tools/test-workflow/build-cn.test.cjs",
        "tools/test-workflow/package-scripts.test.cjs",
        "tools/test-workflow/select-tests.test.cjs",
        "tools/test-workflow/run.test.cjs",
        "tools/test-workflow/verify-cn-build.test.cjs",
        "tools/perf/http_metrics.test.cjs",
        "tools/perf/http_baseline.test.cjs",
        "tools/perf/tcp_baseline.test.cjs",
    ])
})

test("keeps compiled-output and external-data tests out of quick", () => {
    assert.equal(TEST_GROUPS["quick:quest"].tests.includes("tools/quest_abort_route.test.cjs"), false)
    assert.deepEqual(TEST_GROUPS["integration:compiled"].tests, [
        "tools/quest_abort_route.test.cjs",
        "tools/score_attack_event.test.cjs",
        "tools/treasure_key_entry.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:mission-compiled"].tests, [
        "tools/character_awake_refresh.test.cjs",
        "tools/mission_completion.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:rules"].tests, [
        "tools/additional_reward.test.cjs",
        "tools/character_stack.test.cjs",
        "tools/equipment_enhancement.test.cjs",
        "tools/economy_write_transaction.test.cjs",
        "tools/event_currency.test.cjs",
        "tools/gacha_write_transaction.test.cjs",
        "tools/item_use_cultivate_pack.test.cjs",
        "tools/inventory_write_transaction.test.cjs",
        "tools/inventory_rules.test.cjs",
        "tools/party_loadout_validation.test.cjs",
        "tools/quest_write_transaction.test.cjs",
        "tools/single_continue_route.test.cjs",
        "tools/single_continue_route_errors.test.cjs",
        "tools/score_reward_lottery.test.cjs",
        "tools/quest_score_reward_settlement.test.cjs",
        "tools/reward_campaign.test.cjs",
        "tools/shop_bulk_purchase.test.cjs",
        "tools/shop_reward_purchase_contract.test.cjs",
        "tools/mail_notification.test.cjs",
        "tools/mail_notification_write_routes.test.cjs",
        "tools/mail_reward_fixture.test.cjs",
        "tools/mail_reward_rollback.test.cjs",
    ])
    assert.deepEqual(
        selectTestGroups(["src/lib/item-use-settlement.ts"]),
        ["integration:rules"],
    )
    assert.deepEqual(
        selectTestGroups(["tools/item_use_cultivate_pack.test.cjs"]),
        ["integration:rules"],
    )
    assert.deepEqual(TEST_GROUPS.generator.tests, [
        "tools/boss_battle_multiscene_content.test.cjs",
        "tools/box_gacha_reset.test.cjs",
        "tools/gacha_odds_export.test.cjs",
        "tools/hard_multi_event_quest.test.cjs",
        "tools/periodic_reward.test.cjs",
        "tools/rebuild_gacha_from_odds.test.cjs",
        "tools/score_attack_event_data.test.cjs",
        "tools/star_grain_material_pack.test.cjs",
        "tools/treasure_key_entry_data.test.cjs",
    ])
})

test("quick protocol includes multi runtime lifecycle coverage", () => {
    assert.equal(TEST_GROUPS["quick:protocol"].timeoutMs, 60_000)
    assert.deepEqual(TEST_GROUPS["quick:protocol"].tests, [
        "tools/handshake_lifecycle.test.cjs",
        "tools/global_embedded_startup.test.cjs",
        "tools/lobby_lifecycle.test.cjs",
        "tools/msgpack_compat.test.cjs",
        "tools/multi_admission.test.cjs",
        "tools/multi_battle_multiscene.test.cjs",
        "tools/multi_compatibility.test.cjs",
        "tools/multi_coordinator_contract.test.cjs",
        "tools/multi_coordinator_embedded.test.cjs",
        "tools/multi_coordinator_router.test.cjs",
        "tools/multi_context_initialization.test.cjs",
        "tools/multi_finish_follow_info.test.cjs",
        "tools/multi_player_context.test.cjs",
        "tools/multi_player_snapshot.test.cjs",
        "tools/multi_quest_availability.test.cjs",
        "tools/multi_remote_coordinator.test.cjs",
        "tools/multi_remote_settlement.test.cjs",
        "tools/multi_load_recovery.test.cjs",
        "tools/multi_room_handshake_identity.test.cjs",
        "tools/multi_room_identity.test.cjs",
        "tools/npc_contributor_names.test.cjs",
        "tools/npc_nickname_pool.test.cjs",
        "tools/room_cleanup_lifecycle.test.cjs",
        "tools/session_frame_order.test.cjs",
        "tools/session_server_lifecycle.test.cjs",
    ])
})

test("quick character includes growth transaction rollback coverage", () => {
    assert.equal(TEST_GROUPS["quick:character"].timeoutMs, 60_000)
    assert.deepEqual(TEST_GROUPS["quick:character"].tests, [
        "tools/character_awake_eligibility.test.cjs",
        "tools/character_growth_transaction.test.cjs",
        "tools/ex_boost_pending_draw.test.cjs",
        "tools/small_write_route_boundaries.test.cjs",
        "tools/mana_board_availability.test.cjs",
        "tools/player_awake_save_roundtrip.test.cjs",
    ])
})
