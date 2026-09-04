"use strict"

// Minimal dependency guard replacing the D14 migration-era AST callsite
// matrix (DEBT-T01, closed by D23): the owner boundary is enforced by a
// declarative zero-bypass scan instead of a frozen per-call inventory.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")

// Adapters that may talk raw SQL to Character persistent tables. Everything
// else must go through the Growth owner commands / domain setters.
const DECLARED_SQL_ADAPTERS = new Set([
    "data/domains/character.ts",       // domain setters + admin/repair helpers
    "data/domains/character_awake.ts", // awake unlock domain setter (facts + restore)
    "data/domains/player.ts",          // account init + merged replace (V2 restore chain)
    "data/domains/reward-acquisition.ts", // gacha acquisition batch adapter (D20)
    "data/player-save/v2.ts",          // V2 save restore
    "data/updaters/wdfpData.ts",       // schema migrations
    "lib/character-growth/mutation-support.ts", // owner batch write primitive
])

const CHARACTER_WRITE_TABLES = [
    "players_characters",
    "players_characters_bond_tokens",
    "players_characters_mana_nodes",
    "players_character_awake_unlocks",
]

function listSourceFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
    const files = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...listSourceFiles(full))
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full)
    }
    return files
}

function relativeToSource(file) {
    return path.relative(sourceRoot, file).split(path.sep).join("/")
}

test("character persistent-table SQL writes exist only in declared adapters", () => {
    const violations = []
    for (const file of listSourceFiles(sourceRoot)) {
        const relative = relativeToSource(file)
        const source = fs.readFileSync(file, "utf8")
        for (const table of CHARACTER_WRITE_TABLES) {
            const pattern = new RegExp(
                `(UPDATE\\s+|INSERT\\s+INTO\\s+|DELETE\\s+FROM\\s+)${table}\\b`,
                "i",
            )
            if (pattern.test(source) && !DECLARED_SQL_ADAPTERS.has(relative)) {
                violations.push(`${relative} writes ${table}`)
            }
        }
    }
    assert.deepEqual(violations, [])
})

test("growth batch write primitive stays inside the owner package", () => {
    const importers = []
    for (const file of listSourceFiles(sourceRoot)) {
        const relative = relativeToSource(file)
        if (relative.startsWith("lib/character-growth/")) continue
        const source = fs.readFileSync(file, "utf8")
        if (/updateCharacterGrowthRowsSync/.test(source)) importers.push(relative)
    }
    assert.deepEqual(importers, [])
})

test("awake unlock publication writers are only invoked by the owner package", () => {
    const writers = [
        "publishAwakeUnlockCharacterListWithinTransaction",
        "publishEvaluatedAwakeUnlockCharacterListWithinTransaction",
        "publishAwakeUnlockCharacterListWithStateWithinTransaction",
    ]
    const importers = []
    for (const file of listSourceFiles(sourceRoot)) {
        const relative = relativeToSource(file)
        if (relative.startsWith("lib/character-growth/")) continue
        const source = fs.readFileSync(file, "utf8")
        const hit = writers.find(writer => source.includes(writer))
        if (hit !== undefined) importers.push(`${relative} references ${hit}`)
    }
    assert.deepEqual(importers, [])
})

test("the declared adapter list itself stays minimal and existing", () => {
    for (const adapter of DECLARED_SQL_ADAPTERS) {
        assert.ok(
            fs.existsSync(path.join(sourceRoot, adapter)),
            `declared adapter ${adapter} no longer exists; update the guard`,
        )
    }
})
