const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { AGGREGATE_GROUPS, TEST_GROUPS } = require("./groups.cjs")
const { selectTestGroups } = require("./select-tests.cjs")

test("maps representative source files to focused groups", () => {
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
    assert.deepEqual(selectTestGroups(["src/lib/gacha.ts"]), ["quick:gacha"])
    assert.deepEqual(
        selectTestGroups(["src/lib/seed-validator.ts"]),
        ["quick:gacha", "quick:seed"],
    )
    assert.deepEqual(selectTestGroups(["src/runtime/seed-state-store.ts"]), ["quick:seed"])
    assert.deepEqual(selectTestGroups(["src/runtime/seed-state-schema.ts"]), ["quick:seed"])
    assert.deepEqual(selectTestGroups(["docs/protocol/seed-verification.md"]), ["quick:seed"])
    assert.deepEqual(selectTestGroups(["src/lib/gacha-draw.ts"]), ["quick:gacha"])
    assert.deepEqual(
        selectTestGroups(["src/content/paths.ts"]),
        ["quick:cdn", "quick:content"],
    )
    assert.deepEqual(selectTestGroups(["src/content/cdn/types.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/catalog-builder.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/runtime-manifest.ts"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/patch-graph.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/digest-cache.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/catalog.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/planner.ts"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["src/content/cdn/audit.ts"]), ["integration:cdn"])
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
    assert.deepEqual(selectTestGroups(["src/routes/cn/asset.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/assetInTitle.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/cdnFiles.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/httpRange.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/msgpack.ts"]), ["full", "integration:cdn"])
    assert.deepEqual(selectTestGroups(["src/lib/version.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/routes/cn/load.ts"]), ["full"])
    assert.deepEqual(
        selectTestGroups(["src/cn-server.ts"]),
        ["full", "integration:cdn", "integration:database", "integration:runtime"],
    )
    assert.deepEqual(
        selectTestGroups(["src/server.ts"]),
        ["full", "integration:cdn", "integration:database"],
    )
    assert.deepEqual(
        selectTestGroups(["src/data/index.ts"]),
        ["full", "integration:database"],
    )
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
        ["integration:runtime", "quick:runtime"],
    )
    assert.deepEqual(selectTestGroups(["tools/server-bundle/build.cjs"]), ["quick:runtime"])
    assert.deepEqual(selectTestGroups(["tools/server-bundle/verify.cjs"]), ["quick:runtime"])
    assert.deepEqual(selectTestGroups(["docs/runtime/server-bundle.md"]), ["quick:runtime"])
    assert.deepEqual(
        selectTestGroups(["src/content/startup/bootstrap.ts"]),
        ["integration:runtime", "quick:content"],
    )
    assert.deepEqual(
        selectTestGroups(["src/multi/tcp/server.ts"]),
        ["integration:runtime", "quick:protocol"],
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
        ["integration:compiled", "integration:quest", "quick:quest"],
    )
})

test("selects only the direct single battle route regressions", () => {
    const groups = selectTestGroups(["src/routes/api/singleBattleQuest.ts"])
    assert.deepEqual(groups, ["integration:compiled", "integration:quest", "quick:quest"])
    assert.deepEqual(groups.flatMap(group => TEST_GROUPS[group].tests), [
        "tools/quest_abort_route.test.cjs",
        "tools/score_attack_event.test.cjs",
        "tools/treasure_key_entry.test.cjs",
        "tools/quest_entry_lifecycle.test.cjs",
        "tools/quest_host_finish.test.cjs",
        "tools/active_quest_service_import.test.cjs",
        "tools/special_quest_flow.test.cjs",
    ])
})

test("upgrades package and unknown source changes to full", () => {
    assert.deepEqual(selectTestGroups(["package.json"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/unmapped/new-feature.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/lib/mission/awake-settlement.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["src/lib/character.ts"]), ["full"])
    assert.deepEqual(selectTestGroups(["tools/test-workflow/groups.cjs"]), ["full"])
})

test("deduplicates and stably sorts selected groups", () => {
    assert.deepEqual(
        selectTestGroups([
            "src/lib/gacha.ts",
            "admin/src/App.tsx",
            "src/lib/quest/host-finish-persistence.ts",
            "src/lib/gacha.ts",
        ]),
        ["admin", "integration:quest", "quick:gacha", "quick:quest"],
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
})

test("registers focused runtime state and socket smoke groups", () => {
    assert.deepEqual(TEST_GROUPS["quick:runtime"], {
        execution: "parallel",
        tests: [
            "tools/server_bundle.test.cjs",
            "tools/runtime_bundle_metadata.test.cjs",
            "tools/runtime_config.test.cjs",
            "tools/runtime_health.test.cjs",
            "tools/runtime_lifecycle.test.cjs",
        ],
    })
    assert.deepEqual(TEST_GROUPS["integration:runtime"], {
        execution: "serial",
        tests: ["tools/runtime_compiled_smoke.test.cjs"],
    })
})

test("registers focused seed state and API regressions", () => {
    assert.deepEqual(TEST_GROUPS["quick:seed"], {
        execution: "parallel",
        tests: [
            "tools/seed_api.test.cjs",
            "tools/seed_state.test.cjs",
        ],
    })
    assert.deepEqual(selectTestGroups(["tools/seed_api.test.cjs"]), ["quick:seed"])
    assert.deepEqual(selectTestGroups(["tools/seed_state.test.cjs"]), ["quick:seed"])
})

test("registers the focused CDN path contract", () => {
    assert.deepEqual(TEST_GROUPS["quick:cdn"], {
        execution: "parallel",
        tests: [
            "tools/cdn_catalog.test.cjs",
            "tools/cdn_paths.test.cjs",
            "tools/cdn_planner.test.cjs",
            "tools/cdn_types.test.cjs",
        ],
    })
    assert.deepEqual(selectTestGroups(["tools/cdn_catalog.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_paths.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_planner.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_types.test.cjs"]), ["quick:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_catalog_provider.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_audit.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_runtime_manifest.test.cjs"]), ["integration:cdn"])
    assert.deepEqual(selectTestGroups(["tools/cdn_files.test.cjs"]), ["integration:cdn"])
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
            markers: ["src/routes/api/singleBattleQuest.ts", "scoreAttackEventData"],
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
    assert.equal(TEST_GROUPS["integration:party"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:quest"].execution, "parallel")
    assert.equal(TEST_GROUPS["integration:cdn"].execution, "serial")
})

test("splits isolated integration tests into focused domains", () => {
    assert.deepEqual(TEST_GROUPS["integration:database"].tests, [
        "tools/test-workflow/database-isolation.test.cjs",
        "tools/test-workflow/database-lifecycle.test.cjs",
        "tools/test-workflow/runtime-data-paths.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:event"].tests, [
        "tools/carnival_rewards.test.cjs",
        "tools/rush_event_shop.test.cjs",
        "tools/rush_event_shop_route.test.cjs",
        "tools/score_attack_route_transaction.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:mission"].tests, [
        "tools/character_awake_battle_tracker.test.cjs",
        "tools/character_awake_facts.test.cjs",
        "tools/character_awake_route.test.cjs",
        "tools/character_awake_settlement.test.cjs",
        "tools/character_awake_unlock.test.cjs",
        "tools/mission_battle_facts.test.cjs",
        "tools/mission_auto_settlement_route.test.cjs",
        "tools/mission_collect_progress.test.cjs",
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
    ])
    assert.deepEqual(TEST_GROUPS["integration:quest"].tests, [
        "tools/quest_entry_lifecycle.test.cjs",
        "tools/quest_host_finish.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS["integration:party"].tests, [
        "tools/special_quest_party.test.cjs",
    ])
})

test("quick workflow includes documentation and package script contracts", () => {
    assert.deepEqual(TEST_GROUPS["quick:workflow"].tests, [
        "tools/docs_check.test.cjs",
        "tools/test-workflow/benchmark.test.cjs",
        "tools/test-workflow/build-cn.test.cjs",
        "tools/test-workflow/package-scripts.test.cjs",
        "tools/test-workflow/select-tests.test.cjs",
        "tools/test-workflow/run.test.cjs",
        "tools/test-workflow/verify-cn-build.test.cjs",
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
        "tools/character_stack.test.cjs",
        "tools/equipment_enhancement.test.cjs",
        "tools/event_currency.test.cjs",
        "tools/inventory_rules.test.cjs",
    ])
    assert.deepEqual(TEST_GROUPS.generator.tests, [
        "tools/box_gacha_reset.test.cjs",
        "tools/gacha_odds_export.test.cjs",
        "tools/rebuild_gacha_from_odds.test.cjs",
        "tools/score_attack_event_data.test.cjs",
        "tools/star_grain_material_pack.test.cjs",
        "tools/treasure_key_entry_data.test.cjs",
    ])
})

test("quick protocol includes multi runtime lifecycle coverage", () => {
    assert.deepEqual(TEST_GROUPS["quick:protocol"].tests, [
        "tools/handshake_lifecycle.test.cjs",
        "tools/lobby_lifecycle.test.cjs",
        "tools/msgpack_compat.test.cjs",
        "tools/multi_player_context.test.cjs",
        "tools/npc_contributor_names.test.cjs",
        "tools/npc_nickname_pool.test.cjs",
        "tools/room_cleanup_lifecycle.test.cjs",
        "tools/session_server_lifecycle.test.cjs",
    ])
})
