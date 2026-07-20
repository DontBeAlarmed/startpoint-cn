const path = require("node:path")

const { TEST_GROUPS } = require("./groups.cjs")

const SOURCE_RULES = [
    { pattern: /^admin\//, groups: ["admin"] },
    { pattern: /^tests\/admin-/, groups: ["admin"] },
    { pattern: /^src\/content\/paths\.ts$/, groups: ["quick:cdn"] },
    { pattern: /^src\/content\/cdn\//, groups: ["quick:cdn"] },
    { pattern: /^src\/routes\/cn\/(?:asset|versionCheck)\.ts$/, groups: ["full"] },
    { pattern: /^src\/routes\/web_api\//, groups: ["admin", "integration:database"] },
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

    const matchedGroups = SOURCE_RULES
        .filter(rule => rule.pattern.test(filePath))
        .flatMap(rule => rule.groups)
    return matchedGroups.length > 0 ? matchedGroups : ["full"]
}

function selectTestGroups(filePaths) {
    const selected = new Set()

    for (const inputPath of filePaths) {
        for (const group of groupsForFile(normalizePath(inputPath))) {
            if (group === "full") return ["full"]
            selected.add(group)
        }
    }

    return [...selected].sort((left, right) => left.localeCompare(right))
}

module.exports = {
    normalizePath,
    selectTestGroups,
}
