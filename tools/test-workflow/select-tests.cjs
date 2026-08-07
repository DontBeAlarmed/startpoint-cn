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
    { pattern: /^admin\//, groups: ["admin"] },
    { pattern: /^tests\/admin-/, groups: ["admin"] },
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
        pattern: /^src\/routes\/cn\/(?:asset|assetInTitle|asset-provider|cdnFiles|httpRange|msgpack)\.ts$/,
        groups: ["integration:cdn", "full"],
    },
    { pattern: /^src\/routes\/cn\/versionCheck\.ts$/, groups: ["full"] },
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
        pattern: /^docs\/systems\/save-validation\.md$/,
        groups: ["integration:database"],
    },
    {
        pattern: /^src\/runtime\/data-paths\.ts$/,
        groups: ["integration:database", "quick:cdn", "quick:content"],
    },
    { pattern: /^src\/lib\/gacha-seed-quarantine\.ts$/, groups: ["quick:seed", "quick:gacha"] },
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
        pattern: /^src\/lib\/(?:gacha|gacha-draw|gacha-equipment-movie|gacha-exec-plan|gacha-rules|gacha-seed-catalog|gacha-ticket)\.ts$/,
        groups: ["quick:gacha"],
    },
    {
        pattern: /^src\/routes\/api\/gacha\.ts$/,
        groups: ["integration:rules", "quick:gacha"],
    },
    { pattern: /^src\/routes\/web_api\/seeds\.ts$/, groups: ["quick:seed"] },
    {
        pattern: /^src\/routes\/api\/singleBattleQuest\.ts$/,
        groups: ["integration:compiled", "integration:quest", "quick:quest"],
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
        pattern: /^(?:assets\/mana_board2_open_condition\.json|src\/lib\/mana-board-availability\.ts|src\/routes\/api\/character\/(?:mana|bond)\.ts|src\/data\/utils\/serialize-player\.ts)$/,
        groups: ["quick:character", "quick:content"],
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
        pattern: /^src\/routes\/api\/(?:exchange|expod)\.ts$/,
        groups: ["integration:rules"],
    },
    {
        pattern: /^src\/lib\/mission\/(?:event-battle-facts|event-entry-facts|computer-event|coverage-audit|computer-degree|degree-battle-facts|degree-operation-facts)\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/routes\/api\/raidEvent\.ts$/,
        groups: ["integration:event", "integration:mission"],
    },
    {
        pattern: /^src\/routes\/api\/boxGacha\.ts$/,
        groups: ["integration:event"],
    },
    {
        pattern: /^src\/routes\/api\/party\.ts$/,
        groups: ["integration:mission", "integration:party"],
    },
    {
        pattern: /^src\/data\/domains\/event_mission_entry_facts\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^src\/lib\/mission\/active-mission-specific-battle-facts\.ts$/,
        groups: ["integration:mission"],
    },
    {
        pattern: /^(?:assets\/server\/npc_contributor_names\.json|tools\/npc_contributor_names(?:\.test)?\.cjs)$/,
        groups: ["quick:protocol"],
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
