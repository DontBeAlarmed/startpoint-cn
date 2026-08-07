"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")

const cdnTables = new Set(
    TABLE_SOURCES
        .filter(definition => definition.scope === "cdn")
        .map(definition => definition.tableName),
)

const bundledStartupExceptions = new Map([
    ["src/data/updaters/wdfpData.ts", new Map([
        ["mission_char_awake_reward.json", "数据库初始化早于 ContentSnapshot，历史 schema 默认值必须使用 bundled 表"],
    ])],
])

// This is the audit baseline produced by the architecture review. Existing
// asset adapters outside this set already route through lib/assets.ts; these
// are the remaining production modules that still need an explicit boundary.
const runtimeBoundaryCandidates = new Set([
    "src/lib/mission/active-master-data.ts",
    "src/lib/mission/awake-rule-catalog.ts",
    "src/lib/mission/character-queries.ts",
    "src/lib/mission/computer-event.ts",
    "src/lib/mission/event-entry-facts.ts",
    "src/lib/mission/master-data.ts",
    "src/lib/mission/rewards.ts",
    "src/lib/mission/stages.ts",
    "src/lib/pass-card.ts",
    "src/lib/quest.ts",
    "src/lib/stamina-campaign.ts",
    "src/multi/player-context.ts",
    "src/routes/api/exBoost.ts",
    "src/routes/api/exchange.ts",
    "src/routes/web_api/mail.ts",
    "src/routes/web_api/validation.ts",
    "src/data/updaters/wdfpData.ts",
])

function listSources(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name)
        return entry.isDirectory() ? listSources(entryPath) : [entryPath]
    }).filter(filePath => filePath.endsWith(".ts"))
}

function importedCdnFallbacks(source) {
    const fallbacks = new Map()
    for (const match of source.matchAll(
        /import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](?:\.\.\/)+assets\/([^"']+)["']/g,
    )) {
        if (cdnTables.has(match[2])) fallbacks.set(match[2], match[1])
    }
    for (const match of source.matchAll(
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["'](?:\.\.\/)+assets\/([^"']+)["']\)/g,
    )) {
        if (cdnTables.has(match[2])) fallbacks.set(match[2], match[1])
    }
    return fallbacks
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasRuntimeTableAccess(source, tableName, fallbackName) {
    const escapedTableName = escapeRegExp(tableName)
    const directAccess = new RegExp(
        `(?:getRuntimeContentTableSync|getQuestContentTableSync|repository\\.table)[\\s\\S]{0,240}${escapedTableName}`,
    ).test(source)
    if (directAccess) return true
    if (!fallbackName) return false

    const escapedFallbackName = escapeRegExp(fallbackName)
    const describedSource = new RegExp(
        `tableName:\\s*["']${escapedTableName}["'][\\s\\S]{0,240}bundledBeforeInitialization:\\s*${escapedFallbackName}`,
    ).test(source)
    const genericAccess = /getRuntimeContentTableSync\(\s*source\.tableName,\s*source\.bundledBeforeInitialization/.test(source)
    return describedSource && genericAccess
}

test("production modules route CDN-scoped bundled fallbacks through ContentSnapshot", () => {
    const violations = []
    for (const filePath of listSources(sourceRoot)) {
        const source = fs.readFileSync(filePath, "utf8")
        const fallbacks = importedCdnFallbacks(source)
        const tables = [...fallbacks.keys()]
        if (tables.length === 0) continue
        const relativeFile = path.relative(projectRoot, filePath).replaceAll(path.sep, "/")
        if (!runtimeBoundaryCandidates.has(relativeFile)) continue
        const exceptions = bundledStartupExceptions.get(relativeFile) ?? new Map()
        for (const table of tables) {
            if (exceptions.has(table)) continue
            if (!hasRuntimeTableAccess(source, table, fallbacks.get(table))) {
                violations.push({ file: relativeFile, table })
            }
        }
        for (const [table, reason] of exceptions) {
            assert.ok(
                tables.includes(table),
                `stale startup exception ${relativeFile} -> ${table}: ${reason}`,
            )
            assert.notEqual(reason, "", `startup exception needs a reason: ${relativeFile} -> ${table}`)
        }
    }
    assert.deepEqual(violations, [])
})
