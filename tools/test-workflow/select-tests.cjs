const path = require("node:path")

const { TEST_GROUPS } = require("./groups.cjs")

const SOURCE_RULES = [
    { pattern: /^admin\//, groups: ["admin"] },
    { pattern: /^tests\/admin-/, groups: ["admin"] },
    { pattern: /^src\/routes\/cn\/(?:asset|versionCheck)\.ts$/, groups: ["full"] },
    { pattern: /^src\/routes\/web_api\//, groups: ["admin"] },
    { pattern: /^src\/lib\/gacha(?:[\/.\-]|\.ts$)/, groups: ["quick:gacha"] },
    { pattern: /^src\/lib\/quest\/host-finish-persistence\.ts$/, groups: ["integration:database"] },
    { pattern: /^src\/lib\/quest\//, groups: ["quick:quest"] },
    { pattern: /^src\/lib\/mission\/awake-unlock\.ts$/, groups: ["integration:database"] },
    { pattern: /^src\/lib\/mission\//, groups: ["integration:compiled"] },
    { pattern: /^src\/lib\/(?:character|equipment|event-currency|inventory)/, groups: ["integration:compiled"] },
    { pattern: /^src\/lib\/score-attack/, groups: ["generator"] },
    { pattern: /^src\/multi\//, groups: ["quick:protocol"] },
    { pattern: /^src\/data\//, groups: ["integration:database"] },
    { pattern: /^src\/routes\//, groups: ["integration:database"] },
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
