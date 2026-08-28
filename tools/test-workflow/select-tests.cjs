const path = require("node:path")

const { TEST_GROUPS } = require("./groups.cjs")

const HUB_AUTHENTICATION_FILES = new Set([
    "src/multi/hub/authentication-rejections.ts",
    "src/multi/hub/credential-reloader.ts",
    "tools/multi_hub_authentication.test.cjs",
])
const HUB_AUTHENTICATION_GROUPS = [
    "integration:multi-hub",
    "quick:protocol",
    "quick:runtime",
]

const SOURCE_RULES = [
    {
        pattern: /^tools\/(?:active_mission_evaluator_equivalence\.test|helpers\/active-mission-legacy-evaluator)\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/helpers\/mission-degree-session-fixture\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/character\.ts$/,
        groups: ["full"],
    },
    {
        pattern: /^tools\/mission_degree_reference_regressions\.test\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/mission_regular_chapter_regressions\.test\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/(?:computer-degree|degree-(?:content-tables|coverage|immutable|rule-catalog|state-derivation|session-context))\.ts$/,
        groups: ["integration:mission"],
    },
    { pattern: /^admin\//, groups: ["admin"] },
    { pattern: /^tests\/admin-/, groups: ["admin"] },
    {
        pattern: /^src\/(?:data\/domains\/session|validate_cdn)\.ts$/,
        groups: ["quick:workflow"],
    },
    {
        pattern: /^assets\/(?:mission_event|mission_event_battle_rules|boss_battle_quest|advent_event_quest|world_story_event_boss_battle_quest)\.json$/,
        groups: ["generator:mission-event", "integration:mission", "quick:content"],
    },
    {
        pattern: /^scripts\/gen_mission_event_battle_rules\.js$/,
        groups: ["generator:mission-event"],
    },
    {
        pattern: /^src\/content\/paths\.ts$/,
        groups: ["quick:cdn", "quick:content"],
    },
    { pattern: /^src\/content\/audit\//, groups: ["quick:content"] },
    { pattern: /^src\/content\/cdn\/types\.ts$/, groups: ["quick:cdn"] },
    {
        pattern: /^src\/content\/cdn\/(?:archive-sources|patch-manifest)\.ts$/,
        groups: ["quick:cdn"],
    },
    {
        pattern: /^src\/content\/cdn\/patch-overlay\.ts$/,
        groups: ["quick:cdn", "quick:content"],
    },
    {
        pattern: /^src\/content\/cdn\/(?:catalog-builder|patch-graph|digest-cache|planner)\.ts$/,
        groups: ["quick:cdn"],
    },
    { pattern: /^src\/content\/cdn\/ios-compat\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/lib\/admin-content-status\.ts$/, groups: ["quick:cdn", "admin"] },
    { pattern: /^src\/lib\/admin-multi-status\.ts$/, groups: ["quick:runtime", "admin"] },
    { pattern: /^src\/multi\/management\//, groups: ["quick:runtime"] },
    {
        pattern: /^src\/routes\/web_api\/(?:index|multi-management)\.ts$/,
        groups: ["quick:runtime"],
    },
    {
        pattern: /^tools\/(?:manage_multi_hub_token\.cjs|lib\/multi-hub-env\.cjs)$/,
        groups: ["quick:runtime"],
    },
    {
        pattern: /^src\/content\/(?:cdn\/entity-lists-directory|sync\/scanner)\.ts$/,
        groups: ["quick:cdn", "quick:content"],
    },
    { pattern: /^src\/content\/cdn\/protocol\.ts$/, groups: ["integration:cdn", "full"] },
    { pattern: /^src\/content\/cdn\/asset-mode\.ts$/, groups: ["integration:cdn", "full"] },
    { pattern: /^src\/content\/cdn\/runtime-manifest\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/cdn\/catalog-loader\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/cdn\/audit\.ts$/, groups: ["integration:cdn"] },
    {
        pattern: /^src\/content\/runtime\/content-snapshot\.ts$/,
        groups: ["integration:cdn", "quick:content"],
    },
    {
        pattern: /^src\/content\/runtime\/content-repository\.ts$/,
        groups: ["quick:content"],
    },
    {
        pattern: /^src\/lib\/character-content\.ts$/,
        groups: ["quick:content", "admin", "integration:quest"],
    },
    { pattern: /^src\/content\/deep-freeze\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/lib\/version\.ts$/, groups: ["full"] },
    { pattern: /^src\/routes\/cn\/load\.ts$/, groups: ["full", "integration:mission", "quick:protocol"] },
    {
        pattern: /^src\/cn-server\.ts$/,
        groups: [
            "integration:cdn",
            "integration:database",
            "integration:multi-hub",
            "integration:runtime",
            "full",
        ],
    },
    {
        pattern: /^src\/server\.ts$/,
        groups: ["integration:cdn", "integration:database", "full"],
    },
    {
        pattern: /^src\/routes\/cn\/(?:asset|assetInTitle|asset-provider|cdnFiles|httpRange|ios-leiting|msgpack)\.ts$/,
        groups: ["integration:cdn", "full"],
    },
    { pattern: /^src\/routes\/cn\/versionCheck\.ts$/, groups: ["integration:cdn", "full"] },
    { pattern: /^src\/routes\/web_api\//, groups: ["admin", "integration:database"] },
    {
        pattern: /^src\/data\/(?:player-save\/|defaultSave\.ts$)/,
        groups: ["integration:database"],
    },
    {
        pattern: /^src\/lib\/quest\/active-quest-service\.ts$/,
        groups: ["integration:quest", "quick:quest"],
    },
    {
        pattern: /^(?:src\/lib\/quest\/single-continue-lifecycle\.ts|tools\/helpers\/single-continue-fixture\.cjs)$/,
        groups: ["integration:quest", "integration:rules", "quick:quest"],
    },
    {
        pattern: /^(?:src\/lib\/quest\/finish\/session-validator\.ts|tools\/quest_session_identity\.test\.cjs)$/,
        groups: ["integration:quest", "quick:quest"],
    },
    {
        pattern: /^(?:src\/lib\/quest\/(?:abort-request-validation|entry-lifecycle|start-entry)\.ts|src\/routes\/api\/singleBattleQuest\.ts|tools\/(?:quest_abort_route|quest_entry_lifecycle|single_battle_(?:abort_(?:numeric_)?validation|identity_reads)|single_continue_(?:idempotency|lifecycle|route|route_errors))\.test\.cjs)$/,
        groups: ["integration:quest", "integration:rules", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/quest\/single-finish-settlement\.ts$/,
        groups: ["integration:quest"],
    },
    {
        pattern: /^src\/lib\/quest\/finish\/single-orchestrator\.ts$/,
        groups: ["integration:mission", "integration:quest", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/quest\/finish\/single-settlement-(?:response-state|writes)\.ts$/,
        groups: [
            "integration:compiled",
            "integration:event",
            "integration:mission",
            "integration:quest",
            "integration:reward-grant",
            "quick:modes",
            "quick:quest",
        ],
    },
    {
        pattern: /^src\/lib\/quest\/finish\/single-response-projector\.ts$/,
        groups: [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "quick:content",
            "quick:quest",
        ],
    },
    {
        pattern: /^src\/lib\/quest\/single-finish-validation\.ts$/,
        groups: ["integration:quest"],
    },
    {
        pattern: /^(?:src\/lib\/reward-grant\/.*\.ts|docs\/systems\/reward-grant-transactions\.md)$/,
        groups: ["integration:reward-grant"],
    },
    {
        pattern: /^(?:src\/lib\/quest\/finish\/(?:single-settlement-reward-grant|single-standard-reward-callbacks)\.ts|tools\/(?:single_settlement_reward_grant|task23c_reward_grants)\.test\.cjs)$/,
        groups: ["integration:reward-grant"],
    },
    {
        pattern: /^src\/lib\/quest\/finish\/single-mission-settlement\.ts$/,
        groups: ["integration:mission", "integration:quest", "integration:reward-grant", "quick:quest"],
    },
    {
        pattern: /^(?:src\/lib\/quest\/score-reward-(?:selection(?:-core)?|normalization|projection|settlement)\.ts|docs\/systems\/quest-score-rewards\.md)$/,
        groups: ["integration:reward-grant", "integration:rules", "quick:quest"],
    },
    {
        pattern: /^docs\/systems\/save-validation\.md$/,
        groups: ["integration:database"],
    },
    {
        pattern: /^src\/runtime\/data-paths\.ts$/,
        groups: ["integration:database", "quick:cdn", "quick:content"],
    },
    { pattern: /^src\/lib\/gacha-seed-quarantine\.ts$/, groups: ["quick:seed", "quick:gacha"] },
    { pattern: /^src\/lib\/sampled-log\.ts$/, groups: ["quick:workflow"] },
    {
        pattern: /^src\/lib\/hot-path-log-formatters\.ts$/,
        groups: ["quick:gacha", "quick:quest"],
    },
    { pattern: /^tools\/gacha-faithful\//, groups: ["quick:seed"] },
    { pattern: /^assets\/gacha-seed-catalog\//, groups: ["quick:seed"] },
    {
        pattern: /^src\/runtime\/(?:bundle-metadata|config|health|lifecycle)\.ts$/,
        groups: ["quick:runtime", "integration:runtime", "integration:multi-hub"],
    },
    {
        pattern: /^src\/multi\/(?:hub|runtime)\//,
        groups: ["quick:runtime", "quick:protocol", "integration:multi-hub"],
    },
    {
        pattern: /^src\/runtime\/capabilities\.ts$/,
        groups: ["quick:runtime", "integration:runtime"],
    },
    {
        pattern: /^src\/modes\/(?:loader|registry)\.ts$/,
        groups: ["quick:modes"],
    },
    { pattern: /^tools\/server-bundle\//, groups: ["quick:runtime"] },
    { pattern: /^docs\/runtime\/server-bundle\.md$/, groups: ["quick:runtime"] },
    {
        pattern: /^src\/content\/startup\/bootstrap\.ts$/,
        groups: ["quick:content", "integration:runtime"],
    },
    { pattern: /^src\/content\/sync\/entry\.ts$/, groups: ["quick:content"] },
    {
        pattern: /^src\/content\/(?:converters\/(?:additional-reward|box-gacha|gameplay|item-equipment|mana-node|reward-campaign|skill-effects)|sync\/amf3)\.ts$/,
        groups: ["quick:content"],
    },
    {
        pattern: /^(?:assets\/additional_reward_rules\.json|src\/lib\/additional-reward\.ts)$/,
        groups: ["integration:rules", "quick:content", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/reward-campaign\.ts$/,
        groups: ["integration:rules", "quick:content", "quick:quest"],
    },
    {
        pattern: /^assets\/reward_campaign\.json$/,
        groups: ["quick:content"],
    },
    {
        pattern: /^src\/lib\/(?:gacha|gacha-reward-(?:grant|legacy))\.ts$/,
        groups: ["integration:reward-grant", "integration:rules", "quick:gacha"],
    },
    {
        pattern: /^src\/lib\/(?:gacha-draw|gacha-equipment-movie|gacha-exec-plan|gacha-rules|gacha-seed-catalog|gacha-ticket)\.ts$/,
        groups: ["quick:gacha"],
    },
    {
        pattern: /^src\/lib\/quest\.ts$/,
        groups: ["integration:rules", "quick:quest"],
    },
    {
        pattern: /^(?:src\/lib\/(?:event-shop-purchase|shop-reward-grant)\.ts|src\/lib\/economy\/free-first-deduction\.ts|src\/routes\/api\/shop\.ts)$/,
        groups: ["integration:reward-grant", "integration:rules"],
    },
    {
        pattern: /^(?:src\/lib\/mail-reward-grant\.ts|src\/routes\/api\/mail\.ts|docs\/systems\/mail\.md)$/,
        groups: ["integration:reward-grant", "integration:rules"],
    },
    {
        pattern: /^src\/lib\/receive-history-retention\.ts$/,
        groups: ["integration:database"],
    },
    {
        pattern: /^src\/routes\/api\/gacha\.ts$/,
        groups: ["integration:reward-grant", "integration:rules", "quick:gacha"],
    },
    {
        pattern: /^src\/routes\/api\/tutorial\.ts$/,
        groups: ["integration:quest", "integration:reward-grant", "quick:gacha"],
    },
    { pattern: /^src\/routes\/web_api\/seeds\.ts$/, groups: ["quick:seed"] },
    {
        pattern: /^src\/routes\/api\/singleBattleQuest\.ts$/,
        groups: [
            "integration:compiled",
            "integration:mission",
            "integration:quest",
            "integration:rules",
            "quick:quest",
        ],
    },
    {
        pattern: /^src\/routes\/api\/questUnlock\.ts$/,
        groups: ["integration:rules", "quick:quest"],
    },
    {
        pattern: /^(?:assets\/story_join_character\.json|src\/lib\/story-join-character\.ts|src\/routes\/api\/(?:storyQuest|character)\.ts)$/,
        groups: ["integration:quest", "quick:content"],
    },
    {
        pattern: /^src\/lib\/quest\/host-finish-persistence\.ts$/,
        groups: ["integration:quest", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/mission\/awake-unlock\.ts$/,
        groups: ["integration:mission", "integration:mission-compiled"],
    },
    {
        pattern: /^(?:assets\/(?:mana_node|mana_board2_open_condition)\.json|src\/content\/mana-node-semantics\.ts|src\/lib\/(?:character-evolution|mana-board-availability)\.ts|src\/routes\/api\/character\/(?:mana|mana-awake|bond)\.ts|src\/data\/utils\/serialize-player\.ts|tools\/character_evolution(?:_route)?\.test\.cjs)$/,
        groups: ["quick:character", "quick:content"],
    },
    {
        pattern: /^(?:src\/data\/domains\/character\.ts|src\/routes\/api\/character\/(?:mana|mana-awake)\.ts|tools\/character_mana_batch_writes\.test\.cjs)$/,
        groups: ["integration:rules"],
    },
    {
        pattern: /^(?:src\/routes\/api\/(?:character|exBoost)\.ts|src\/data\/domains\/ex_boost\.ts)$/,
        groups: ["quick:character", "integration:database"],
    },
    {
        pattern: /^(?:src\/routes\/api\/(?:equipment|item|sell)\.ts|src\/lib\/item-sell\.ts)$/,
        groups: ["integration:rules"],
    },
    {
        pattern: /^src\/lib\/item-use-settlement\.ts$/,
        groups: ["integration:rules"],
    },
    {
        pattern: /^src\/routes\/api\/(?:exchange|expod)\.ts$/,
        groups: ["integration:rules"],
    },
    {
        pattern: /^src\/lib\/mission\/(?:battle-facts|event-battle-facts|event-entry-facts|computer-event|coverage-audit|computer-degree|degree-battle-facts|degree-candidates|degree-context-requirements|degree-operation-facts)\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:src\/lib\/mission\/(?:awake-eligibility|awake-evaluation-settlement|awake-request-context(?:-scope|-state)?|awake-reward-facts|awake-settlement|awake-unlock|awake-unlock-response|compute-awake-summary|evaluation-session|fact-loaders|index|mission-catalog|mission-catalog-source|production-fact-loaders)\.ts|src\/data\/domains\/(?:character_clear|party_co_clear)\.ts|tools\/mission_awake_reward_owner\.test\.cjs)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/helpers\/mission-evaluation-(?:rejected-(?:observer|promise)-worker|session-fixture)\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/helpers\/awake-owner-fact-publication-fixture\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/facts\/.*\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/requirements\/.*\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/quest\/finish\/party-co-clear-tracker\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/multi\/http\/battle\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/(?:category-session-plan|collect-progress|collect-session-context|computer-regular|master-value|pass|periodic-session-context|regular-battle-facts|regular-quest-facts|regular-session-context|regular-state-facts|types)\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/settlement\.ts$/,
        groups: ["integration:mission", "integration:reward-grant"],
    },
    {
        pattern: /^src\/lib\/mission\/grants\.ts$/,
        groups: ["integration:mission", "integration:reward-grant"],
    },
    {
        pattern: /^src\/lib\/carnival-rewards\.ts$/,
        groups: ["integration:reward-grant", "integration:event"],
    },
    {
        pattern: /^(?:tools\/perf\/mission_engine_focused_(?:admission|baseline|helpers|report|runner|scenarios)(?:\.test)?\.cjs|tools\/perf\/__snapshots__\/mission_engine_focused_baseline\.json)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:tools\/awake_request_context\.test\.cjs|tools\/awake_reconcile_callsite_matrix\.test\.cjs|tools\/perf\/awake_request_context_(?:admission|baseline|report|runner|scenarios)(?:\.test)?\.cjs|tools\/perf\/__snapshots__\/awake_request_context_baseline\.json)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:tools\/awake_reconcile_owner_call_inventory\.json|tools\/perf\/awake_owner_focused_(?:admission|baseline(?:\.test)?|fixture|observer|report|scenarios)\.cjs|tools\/perf\/__snapshots__\/awake_owner_focused_baseline\.json)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/perf\/active-mission\/(?:admission|fixture|observer|report|workload-overlay)\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:tools\/perf\/active-mission\/(?:baseline(?:\.test)?|scenarios-(?:finish|load|receive))\.cjs|tools\/perf\/__snapshots__\/active_mission_focused_baseline\.json)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/perf\/active_mission_(?:metrics|workload_overlay)\.test\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:tools\/perf\/mission_entry_(?:base_oracle|layered_load|load_metrics|load_scenarios)(?:\.test)?\.cjs|tools\/perf\/__snapshots__\/mission_entry_layered_load_reference\.json)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^tools\/perf\/non_multi_mixed_.*\.cjs$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:tools\/(?:single_battle_finish_validation|single_finish_(?:authority_transaction|awake_reward_owner|final_projection|orchestrator_architecture|request_validation))\.test\.cjs|tools\/perf\/single_battle_settlement_(?:(?:admission|baseline)(?:\.test)?|fixture|harness|request_runner|scenario_helpers|time|(?:lifecycle|finish)_scenarios|scenarios)\.cjs|tools\/perf\/__snapshots__\/single_battle_settlement_baseline\.json)$/,
        groups: ["integration:quest"],
    },
    {
        pattern: /^(?:src\/lib\/mission\/settlement-(?:prepare|evaluate)\.ts|tools\/fixtures\/mission-settlement-pipeline-base\.json|tools\/mission_settlement_base_oracle\.test\.cjs)$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/settlement-write\.ts$/,
        groups: ["integration:mission", "integration:reward-grant"],
    },
    {
        pattern: /^tools\/oracle\/(?:git-object-runtime(?:\.test)?|generate_mission_(?:entry_load|settlement)_base|mission_(?:entry_load|settlement)_base_collector)\.cjs$/,
        groups: ["integration:mission"],
    },
    { pattern: /^src\/data\/domains\/(?:item|shopPurchase)\.ts$/, groups: ["integration:mission"] },
    {
        pattern: /^(?:src\/data\/domains\/pass-card|src\/routes\/api\/passCard)\.ts$/,
        groups: ["integration:mission"],
    },
    { pattern: /^src\/routes\/api\/profile\.ts$/, groups: ["quick:character"] },
    {
        pattern: /^src\/routes\/api\/raidEvent\.ts$/,
        groups: ["integration:event", "integration:mission"],
    },
    {
        pattern: /^src\/routes\/api\/boxGacha\.ts$/,
        groups: ["integration:event"],
    },
    {
        pattern: /^src\/(?:lib\/(?:how-to-get|shop-sales-list)|routes\/api\/howToGet)\.ts$/,
        groups: ["integration:event"],
    },
    {
        pattern: /^src\/routes\/api\/party\.ts$/,
        groups: ["integration:mission", "integration:party"],
    },
    {
        pattern: /^src\/data\/domains\/mission\.ts$/,
        groups: ["integration:database", "integration:mission"],
    },
    {
        pattern: /^src\/data\/domains\/event_mission_entry_facts\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/active-mission-specific-battle-facts\.ts$/,
        groups: ["integration:mission"],
    },
    { pattern: /^src\/lib\/mission\/active-.*\.ts$/, groups: ["integration:mission"] },
    { pattern: /^src\/routes\/api\/activeMission\.ts$/, groups: ["integration:mission"] },
    { pattern: /^src\/data\/domains\/active_mission(?:_.*)?\.ts$/, groups: ["integration:mission"] },
    {
        pattern: /^(?:assets\/server\/npc_contributor_names\.json|tools\/npc_contributor_names(?:\.test)?\.cjs)$/,
        groups: ["quick:protocol"],
    },
    {
        pattern: /^(?:docs\/systems\/full-server-acceptance\.md|tests\/helpers\/multi-hub-(?:battle-flow|process-harness)\.js|tools\/perf\/(?:full_server_acceptance(?:_safety|_test_helpers)?|multi_hub_load_(?:metrics|process_fixture|scenarios|workload|workload_test_helpers))\.cjs)$/,
        groups: ["integration:multi-hub"],
    },
    { pattern: /^tools\/perf\/hub_baseline(?:_helpers)?\.cjs$/, groups: ["integration:multi-hub"] },
    {
        pattern: /^src\/multi\/settlement\/(?:orchestrator|response)\.ts$/,
        groups: ["integration:mission", "integration:party"],
    },
    {
        pattern: /^src\/multi\/rescue-fragment-reward\.ts$/,
        groups: ["integration:party"],
    },
    { pattern: /^src\/multi\//, groups: ["quick:protocol", "integration:multi-hub"] },
    { pattern: /^src\/multi\/tcp\/server\.ts$/, groups: ["integration:runtime"] },
    {
        pattern: /^src\/data\/(?!player-save\/|defaultSave\.ts$)/,
        groups: ["integration:database", "full"],
    },
    { pattern: /^src\/routes\/(?!api\/singleBattleQuest\.ts$|web_api\/)/, groups: ["full"] },
]

function normalizePath(filePath) {
    return path.normalize(filePath).replaceAll(path.sep, "/").replace(/^\.\//, "")
}

function groupsForTestFile(filePath) {
    return Object.entries(TEST_GROUPS)
        .filter(([, definition]) => definition.tests.includes(filePath))
        .map(([name]) => name)
}

function groupsForFile(filePath) {
    if (HUB_AUTHENTICATION_FILES.has(filePath)) return HUB_AUTHENTICATION_GROUPS
    const testGroups = groupsForTestFile(filePath)
    if (testGroups.length > 0) return testGroups
    if (filePath === "tools/test-workflow/groups.cjs") return ["full"]
    if (filePath.startsWith("tools/test-workflow/")) return ["quick:workflow"]
    if (filePath === "tools/content_sync_smoke.cjs") return ["integration:content"]
    if (filePath === "tools/content_asset_audit.cjs") return ["quick:content"]
    if (filePath === "tools/audit_cdn_catalog.cjs") return ["integration:cdn"]
    if (filePath === "docs/cdn/catalog-planner.md") return ["integration:cdn"]
    if (filePath === "docs/cdn/content-sync.md") {
        return ["integration:cdn", "integration:content"]
    }
    if (filePath === "docs/protocol/seed-verification.md") return ["quick:seed"]
    if (filePath === "tests/helpers/multi-hub-process-harness.js"
        || filePath.startsWith("tools/fixtures/multi-hub/")
        || [
            "docs/protocol/multi-battle.md",
            "docs/protocol/trusted-multi-hub.md",
            "docs/runtime/android-launcher.md",
            "docs/getting-started/network-boundary.md",
        ].includes(filePath)) return ["integration:multi-hub"]

    const matchedGroups = SOURCE_RULES
        .filter(rule => rule.pattern.test(filePath))
        .flatMap(rule => rule.groups)
    return matchedGroups.length > 0 ? matchedGroups : ["full"]
}

function selectTestGroups(filePaths) {
    const selected = new Set()

    for (const inputPath of filePaths) {
        for (const group of groupsForFile(normalizePath(inputPath))) {
            selected.add(group)
        }
    }

    return [...selected].sort((left, right) => left.localeCompare(right))
}

module.exports = {
    normalizePath,
    selectTestGroups,
}
