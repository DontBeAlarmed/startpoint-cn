"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const inventoryRoot = path.join(projectRoot, "src/lib/inventory")
const c2Files = [
    "batch-context.ts",
    "errors.ts",
    "index.ts",
    "model.ts",
    "owner.ts",
    "sqlite-repository.ts",
]

function source(relativePath) {
    return fs.readFileSync(path.join(inventoryRoot, relativePath), "utf8")
}

test("C2 owner does not activate cap, expiry, Mana, Mail, load or routes", () => {
    const combined = c2Files.map(source).join("\n")
    for (const forbidden of [
        "item-cap-plan",
        "event-trade-expiry-plan",
        "mana-capacity-plan",
        "/load",
        "domains/mail",
        "domains/player",
        "routes/",
    ]) {
        assert.doesNotMatch(combined, new RegExp(forbidden.replace("/", "\\/")), forbidden)
    }
})

test("public Inventory business API excludes maintenance absolute set and delete", () => {
    const barrel = source("index.ts")
    assert.doesNotMatch(barrel, /setInventory|deleteInventory|maintenance|import/i)
    assert.match(barrel, /grantInventoryItemSync/)
    assert.match(barrel, /deductInventoryItemSync/)
    assert.match(barrel, /restoreInventoryItemSync/)
    assert.match(barrel, /withInventoryBatchContextWithinTransactionSync/)
    assert.doesNotMatch(barrel, /createInventoryBatchContextWithinTransactionSync/)
})

test("SQLite row-existence facts remain inside repository and batch context", () => {
    const publicFiles = ["index.ts", "model.ts", "owner.ts", "errors.ts"]
        .map(source)
        .join("\n")
    assert.doesNotMatch(publicFiles, /rowExists|hasExistingRow/)
    assert.match(source("sqlite-repository.ts"), /rowExists/)
    for (const file of c2Files.filter(file => !["batch-context.ts", "sqlite-repository.ts"].includes(file))) {
        assert.doesNotMatch(source(file), /sqlite-repository/, file)
    }
})

test("C3 Inventory imports match the reviewed writer migration inventory", () => {
    const sourceRoot = path.join(projectRoot, "src")
    const importedOutsideInventory = []
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(absolute)
            else if (entry.isFile() && entry.name.endsWith(".ts")
                && !absolute.startsWith(inventoryRoot + path.sep)) {
                const contents = fs.readFileSync(absolute, "utf8")
                if (/lib\/inventory|\.\/inventory|\.\.\/inventory/.test(contents)) {
                    importedOutsideInventory.push(path.relative(projectRoot, absolute))
                }
            }
        }
    }
    visit(sourceRoot)
    const reviewedMigrations = [
        "src/lib/character-growth/commands/awake-mana-nodes.ts",
        "src/lib/character-growth/commands/learn-mana-nodes.ts",
        "src/lib/item-sell.ts",
        "src/lib/item-use-settlement.ts",
    ]
    assert.deepEqual(importedOutsideInventory.sort(), reviewedMigrations)
    for (const relativePath of reviewedMigrations) {
        const contents = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        assert.doesNotMatch(contents, /data\/domains\/item/, relativePath)
    }

    const legacy = fs.readFileSync(path.join(projectRoot, "src/data/domains/item.ts"), "utf8")
    assert.match(legacy, /export function givePlayerItemSync/)
    assert.match(legacy, /export function givePlayerItemWithinTransactionSync/)
    assert.match(legacy, /export function setPlayerItemSync/)
})
