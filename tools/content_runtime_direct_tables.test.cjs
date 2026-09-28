"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
const runtimeTables = new Set(
    TABLE_SOURCES
        .filter(definition => definition.scope !== "server")
        .map(definition => definition.tableName),
)

function listSources(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name)
        return entry.isDirectory() ? listSources(entryPath) : [entryPath]
    }).filter(filePath => filePath.endsWith(".ts"))
}

test("production code has no unapproved static runtime table imports", () => {
    const violations = []
    for (const filePath of listSources(sourceRoot)) {
        const source = fs.readFileSync(filePath, "utf8")
        const relativePath = path.relative(projectRoot, filePath).replaceAll(path.sep, "/")
        for (const match of source.matchAll(
            /import\s+[^;\n]+\s+from\s+["'](?:\.\.\/)+assets\/([^"']+)["']/g,
        )) {
            if (runtimeTables.has(match[1])
                && !(relativePath === "src/data/updaters/wdfpData.ts"
                    && match[1] === "mission_char_awake_reward.json")) {
                violations.push(`${relativePath} -> ${match[1]}`)
            }
        }
    }
    assert.deepEqual(violations, [])
})

test("Star Crumb catalog owns its runtime snapshot tables without a bundled bypass", () => {
    const relativePath = "src/lib/star-crumb-exchange/catalog.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
    assert.match(source, /getContentSnapshot\(\)\.repository/)
    for (const tableName of [
        "star_crumb_exchange.json",
        "star_crumb_exchange_cost.json",
    ]) {
        assert.match(source, new RegExp(`repository\\.table[\\s\\S]*?"${tableName.replace(".", "\\.")}"`))
    }
    assert.doesNotMatch(source, /assets\/star_crumb_exchange|getRuntimeContentTableSync/)
})

test("Bond Token catalog owns its runtime snapshot table without a bundled bypass", () => {
    const relativePath = "src/lib/bond-token-exchange/catalog.ts"
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
    assert.match(source, /getContentSnapshot\(\)\.repository/)
    assert.match(source, /repository\.table[\s\S]*?"bond_token_exchange\.json"/)
    assert.doesNotMatch(source, /assets\/bond_token_exchange|getRuntimeContentTableSync/)
})
