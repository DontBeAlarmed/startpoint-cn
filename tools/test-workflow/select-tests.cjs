const path = require("node:path")

const { TEST_GROUPS } = require("./groups.cjs")

const SOURCE_RULES = [
    { pattern: /^admin\//, groups: ["admin"] },
    { pattern: /^tests\/admin-/, groups: ["admin"] },
    { pattern: /^src\/content\/paths\.ts$/, groups: ["quick:cdn"] },
    { pattern: /^src\/content\/cdn\/types\.ts$/, groups: ["quick:cdn"] },
    {
        pattern: /^src\/content\/cdn\/(?:catalog-builder|patch-graph|digest-cache|planner)\.ts$/,
        groups: ["quick:cdn"],
    },
    { pattern: /^src\/content\/cdn\/protocol\.ts$/, groups: ["integration:cdn", "full"] },
    { pattern: /^src\/content\/cdn\/runtime-manifest\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/cdn\/catalog-loader\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/cdn\/audit\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/runtime\/content-snapshot\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/content\/deep-freeze\.ts$/, groups: ["integration:cdn"] },
    { pattern: /^src\/lib\/version\.ts$/, groups: ["full"] },
    { pattern: /^src\/routes\/cn\/load\.ts$/, groups: ["full"] },
    { pattern: /^src\/cn-server\.ts$/, groups: ["integration:cdn", "full"] },
    {
        pattern: /^src\/routes\/cn\/(?:asset|assetInTitle|cdnFiles|httpRange|msgpack)\.ts$/,
        groups: ["integration:cdn", "full"],
    },
    { pattern: /^src\/routes\/cn\/versionCheck\.ts$/, groups: ["full"] },
    { pattern: /^src\/routes\/web_api\//, groups: ["admin", "integration:database"] },
    { pattern: /^src\/runtime\/data-paths\.ts$/, groups: ["integration:database"] },
    {
        pattern: /^src\/lib\/(?:gacha|gacha-draw|gacha-equipment-movie|gacha-exec-plan|gacha-rules|gacha-ticket)\.ts$/,
        groups: ["quick:gacha"],
    },
    {
        pattern: /^src\/routes\/api\/singleBattleQuest\.ts$/,
        groups: ["integration:compiled", "integration:quest", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/quest\/host-finish-persistence\.ts$/,
        groups: ["integration:quest", "quick:quest"],
    },
    {
        pattern: /^src\/lib\/mission\/awake-unlock\.ts$/,
        groups: ["integration:mission", "integration:mission-compiled"],
    },
    { pattern: /^src\/multi\//, groups: ["quick:protocol"] },
    { pattern: /^src\/data\//, groups: ["full"] },
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
    const testGroups = groupsForTestFile(filePath)
    if (testGroups.length > 0) return testGroups
    if (filePath === "tools/test-workflow/groups.cjs") return ["full"]
    if (filePath.startsWith("tools/test-workflow/")) return ["quick:workflow"]
    if (filePath === "tools/content_sync_smoke.cjs") return ["integration:content"]
    if (filePath === "tools/audit_cdn_catalog.cjs") return ["integration:cdn"]
    if (filePath === "docs/cdn/catalog-planner.md") return ["integration:cdn"]
    if (filePath === "docs/cdn/content-sync.md") {
        return ["integration:cdn", "integration:content"]
    }

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
