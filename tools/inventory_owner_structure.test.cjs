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
    assert.match(barrel, /withDeferredInventoryBatchContextWithinTransactionSync/)
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
        "src/lib/character-growth/commands/bulk-stack-to-exp.ts",
        "src/lib/character-growth/commands/grant-character-stack.ts",
        "src/lib/character-growth/commands/learn-mana-nodes.ts",
        "src/lib/character-growth/commands/over-limit.ts",
        "src/lib/character-growth/commands/stack-to-exp.ts",
        "src/lib/event-shop-purchase.ts",
        "src/lib/item-sell.ts",
        "src/lib/item-use-settlement.ts",
        "src/lib/reward-grant/executor.ts",
        "src/lib/reward-grant/inventory-adapter.ts",
        "src/lib/reward-grant/owner-executor.ts",
        "src/lib/shop-reward-grant.ts",
        "src/routes/api/equipment.ts",
        "src/routes/api/exBoost.ts",
        "src/routes/api/exchange.ts",
        "src/routes/api/questUnlock.ts",
        "src/routes/api/sell.ts",
        "src/routes/api/shop.ts",
    ]
    assert.deepEqual(importedOutsideInventory.sort(), reviewedMigrations)
    for (const relativePath of reviewedMigrations) {
        const contents = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        assert.doesNotMatch(
            contents,
            /\b(?:givePlayerItemSync|givePlayerItemWithinTransactionSync|insertPlayerItemsSync|setPlayerItemSync|setPlayerItemWithinTransactionSync|updatePlayerItemSync|recordPlayerCollectedItemWithinTransactionSync)\b/,
            relativePath,
        )
    }
    assert.match(
        fs.readFileSync(path.join(projectRoot, "src/routes/api/exBoost.ts"), "utf8"),
        /getPlayerItemSync/,
        "W3 migrates EX Boost writes while its response and validation reader remains until W6",
    )
    assert.doesNotMatch(
        fs.readFileSync(path.join(projectRoot, "src/lib/character.ts"), "utf8"),
        /data\/domains\/item/,
        "src/lib/character.ts",
    )
    assert.equal(
        fs.existsSync(path.join(projectRoot, "src/lib/reward-grant/owner-inventory.ts")),
        false,
        "RewardGrant must not retain a second Item cache owner",
    )
    const rewardInventoryAdapter = fs.readFileSync(
        path.join(projectRoot, "src/lib/reward-grant/inventory-adapter.ts"),
        "utf8",
    )
    assert.doesNotMatch(rewardInventoryAdapter, /data\/domains\/item/)
    assert.doesNotMatch(rewardInventoryAdapter, /item-cap-plan|event-trade|mana-capacity|domains\/mail/)
    const rewardExecutor = fs.readFileSync(
        path.join(projectRoot, "src/lib/reward-grant/executor.ts"),
        "utf8",
    )
    assert.doesNotMatch(rewardExecutor, /data\/domains\/item/)
    assert.match(rewardExecutor, /givePlayerCharacterWithinTransactionSync[\s\S]*inventory\.grant/)
    const shopPurchase = fs.readFileSync(
        path.join(projectRoot, "src/lib/event-shop-purchase.ts"),
        "utf8",
    )
    assert.doesNotMatch(shopPurchase, /\b(?:getItem|setItem)\s*:/)
    assert.match(shopPurchase, /dependencies\.withInventory\(/)
    assert.match(shopPurchase, /dependencies\.grantRewards\([\s\S]*inventory/)

    const legacy = fs.readFileSync(path.join(projectRoot, "src/data/domains/item.ts"), "utf8")
    assert.match(legacy, /export function givePlayerItemSync/)
    assert.match(legacy, /export function givePlayerItemWithinTransactionSync/)
    assert.match(legacy, /export function setPlayerItemSync/)
})

test("remaining legacy Item mutation references match the staged migration manifest", () => {
    const sourceRoot = path.join(projectRoot, "src")
    const legacyMutation = /\b(?:givePlayerItemSync|givePlayerItemWithinTransactionSync|insertPlayerItemsSync|setPlayerItemSync|setPlayerItemWithinTransactionSync|updatePlayerItemSync|recordPlayerCollectedItemWithinTransactionSync)\b/
    const remaining = []
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(absolute)
            else if (entry.isFile() && entry.name.endsWith(".ts")
                && legacyMutation.test(fs.readFileSync(absolute, "utf8"))) {
                remaining.push(path.relative(projectRoot, absolute))
            }
        }
    }
    visit(sourceRoot)

    assert.deepEqual(remaining.sort(), [
        // W6 primitive definition / maintenance.
        "src/data/domains/item.ts",
        "src/data/domains/player.ts",
        // W5 legacy Quest / Mission rewards.
        "src/lib/mission/grants.ts",
        "src/lib/quest.ts",
        // W4 Battle entry / restore / settlement.
        "src/lib/quest/active-quest-service.ts",
        "src/lib/quest/finish/periodic-reward-handler.ts",
        "src/lib/quest/finish/single-entry-resource-settlement.ts",
        "src/lib/quest/finish/single-settlement-writes.ts",
        "src/multi/http/battle.ts",
        "src/multi/settlement/orchestrator.ts",
        // Remaining W3 source adapters.
        "src/routes/api/boxGacha.ts",
        "src/routes/api/gacha.ts",
        // W4 Battle route.
        "src/routes/api/singleBattleQuest.ts",
        // W6 maintenance adapter.
        "src/routes/web_api/player.ts",
    ])
})
