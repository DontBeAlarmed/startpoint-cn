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

test("W6a keeps exact Item maintenance separate from business Inventory and V2 restore", () => {
    const maintenance = fs.readFileSync(
        path.join(projectRoot, "src/data/domains/item-maintenance.ts"),
        "utf8",
    )
    assert.deepEqual(
        [...maintenance.matchAll(/export function (\w+)/g)].map(match => match[1]),
        [
            "setPlayerItemForMaintenanceSync",
            "deletePlayerItemForMaintenanceSync",
            "insertPlayerItemsForRestoreImportSync",
        ],
    )
    assert.doesNotMatch(
        maintenance,
        /lib\/inventory|players_collected_items|item-cap-plan|event-trade|mana-capacity|domains\/mail|reward-grant/i,
    )

    const v2 = fs.readFileSync(path.join(projectRoot, "src/data/player-save/v2.ts"), "utf8")
    const registry = fs.readFileSync(path.join(projectRoot, "src/data/player-save/registry.ts"), "utf8")
    assert.doesNotMatch(v2, /item-maintenance|lib\/inventory/)
    assert.match(registry, /table\("players_items", "core"\)/)
    assert.match(registry, /table\("players_collected_items", "core", 6\)/)
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
        "src/lib/box-gacha-reward-grant.ts",
        "src/lib/character-growth/commands/awake-mana-nodes.ts",
        "src/lib/character-growth/commands/bulk-stack-to-exp.ts",
        "src/lib/character-growth/commands/grant-character-stack.ts",
        "src/lib/character-growth/commands/learn-mana-nodes.ts",
        "src/lib/character-growth/commands/over-limit.ts",
        "src/lib/character-growth/commands/stack-to-exp.ts",
        "src/lib/event-shop-purchase.ts",
        "src/lib/event-trade-expiry-settlement.ts",
        "src/lib/gacha-reward-grant.ts",
        "src/lib/item-sell.ts",
        "src/lib/item-use-settlement.ts",
        "src/lib/quest/entry-item-inventory.ts",
        "src/lib/quest/finish/periodic-reward-handler.ts",
        "src/lib/reward-grant/execution-engine.ts",
        "src/lib/reward-grant/executor.ts",
        "src/lib/reward-grant/inventory-adapter.ts",
        "src/lib/reward-grant/owner-executor.ts",
        "src/lib/reward-grant/transaction-executor.ts",
        "src/lib/shop-reward-grant.ts",
        "src/routes/api/boxGacha.ts",
        "src/routes/api/equipment.ts",
        "src/routes/api/exBoost.ts",
        "src/routes/api/exchange.ts",
        "src/routes/api/gacha.ts",
        "src/routes/api/questUnlock.ts",
        "src/routes/api/sell.ts",
        "src/routes/api/shop.ts",
    ]
    assert.deepEqual(importedOutsideInventory.sort(), reviewedMigrations)
    for (const relativePath of reviewedMigrations) {
        const contents = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        assert.doesNotMatch(
            contents,
            /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+players_(?:items|collected_items)/i,
            relativePath,
        )
    }
    assert.match(
        fs.readFileSync(path.join(projectRoot, "src/routes/api/exBoost.ts"), "utf8"),
        /getPlayerItemSync/,
        "EX Boost retains its read-only validation dependency",
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
    const gachaRoute = fs.readFileSync(
        path.join(projectRoot, "src/routes/api/gacha.ts"),
        "utf8",
    )
    assert.match(gachaRoute, /withDeferredInventoryBatchContextWithinTransactionSync\(/)
    assert.match(gachaRoute, /getTicketCount:\s*itemId\s*=>\s*inventory\.read\(itemId\)\.afterAmount/)
    assert.match(gachaRoute, /inventory\.deduct\([\s\S]*execPlan\.ticket\.useTicketCount/)
    assert.match(
        gachaRoute,
        /grantGachaRewardPlanInTransactionOwnerWithInventorySync\([\s\S]*id:\s*player\.id[\s\S]*inventory/,
    )
    const gachaRewardGrant = fs.readFileSync(
        path.join(projectRoot, "src/lib/gacha-reward-grant.ts"),
        "utf8",
    )
    assert.match(
        gachaRewardGrant,
        /function validateGrant\([\s\S]*snapshotRewardGrantExecutionResultForPlan\(playerId, plan, grant\)/,
    )
    assert.match(
        gachaRewardGrant,
        /withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync\([\s\S]*knownPlayerBefore\.id[\s\S]*const result = validateGrant\([\s\S]*execution\.finalize\(\)/,
    )
    const boxGachaRoute = fs.readFileSync(
        path.join(projectRoot, "src/routes/api/boxGacha.ts"),
        "utf8",
    )
    assert.match(boxGachaRoute, /withDeferredInventoryBatchContextWithinTransactionSync\(/)
    assert.match(boxGachaRoute, /inventory\.read\(pullCurrencyId\)\.afterAmount/)
    assert.match(boxGachaRoute, /inventory\.deduct\([\s\S]*pullCurrencyId,[\s\S]*actualDrawCount/)
    assert.match(
        boxGachaRoute,
        /grantBoxGachaDrawInTransactionOwnerWithInventorySync\([\s\S]*drawResult,[\s\S]*player,[\s\S]*inventory/,
    )
    const boxGachaRewardGrant = fs.readFileSync(
        path.join(projectRoot, "src/lib/box-gacha-reward-grant.ts"),
        "utf8",
    )
    assert.match(boxGachaRewardGrant, /inventory\.readMany\(\[\.\.\.drawResult\.items\.keys\(\)\]\)/)
    assert.match(
        boxGachaRewardGrant,
        /withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync\([\s\S]*knownPlayerBefore\.id[\s\S]*snapshotRewardGrantExecutionResultForPlan\([\s\S]*execution\.finalize\(\)/,
    )
    assert.doesNotMatch(boxGachaRoute, /\bgetPlayerItemSync\b/)
    assert.doesNotMatch(
        fs.readFileSync(path.join(projectRoot, "src/lib/gacha.ts"), "utf8"),
        /rewardPlayerBoxGachaResultSync/,
    )

    const battleEntryAdapter = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/entry-item-inventory.ts"),
        "utf8",
    )
    assert.match(battleEntryAdapter, /withInventoryBatchContextWithinTransactionSync\(/)
    assert.match(battleEntryAdapter, /inventory\.deduct\(/)
    assert.match(battleEntryAdapter, /inventory\.restore\(/)
    assert.doesNotMatch(
        battleEntryAdapter,
        /InventoryItemSync\(|item-cap-plan|event-trade|mana-capacity|domains\/mail|getDb\(\)\.transaction|SAVEPOINT/,
    )
    const battleEntryMigrationFiles = [
        "src/lib/quest/active-quest-service.ts",
        "src/lib/quest/finish/single-entry-resource-settlement.ts",
        "src/lib/quest/start-entry.ts",
        "src/multi/http/battle.ts",
        "src/multi/settlement/orchestrator.ts",
        "src/routes/api/singleBattleQuest.ts",
    ]
    for (const relativePath of battleEntryMigrationFiles) {
        const contents = fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
        assert.doesNotMatch(
            contents,
            /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+players_(?:items|collected_items)/i,
            relativePath,
        )
    }
    assert.match(
        fs.readFileSync(path.join(projectRoot, "src/lib/quest/start-entry.ts"), "utf8"),
        /inventory\.readAmount\([\s\S]*dependencies\.computeStamina\([\s\S]*InsufficientEntryItemError[\s\S]*InsufficientStaminaError[\s\S]*inventory\.deduct\([\s\S]*inventory\.flush\(\)/,
    )
    assert.match(
        fs.readFileSync(path.join(projectRoot, "src/lib/quest/entry-lifecycle.ts"), "utf8"),
        /inventory\.restore\([\s\S]*inventory\.flush\(\)[\s\S]*itemList\[prepaidItem\.itemId\] = restored\.afterAmount/,
    )
    const periodicRewardHandler = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/finish/periodic-reward-handler.ts"),
        "utf8",
    )
    assert.match(
        periodicRewardHandler,
        /consumePeriodicRewardPointSync\([\s\S]*remainingPoint === null[\s\S]*withInventoryBatchContextWithinTransactionSync\([\s\S]*inventory\.grant\([\s\S]*inventory\.flush\(\)[\s\S]*item\.afterAmount/,
    )
    assert.doesNotMatch(
        periodicRewardHandler,
        /item-cap-plan|event-trade|mana-capacity|domains\/mail|getDb\(\)\.transaction|SAVEPOINT/,
    )
    const singleSettlementWrites = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/finish/single-settlement-writes.ts"),
        "utf8",
    )
    assert.match(singleSettlementWrites, /getPlayerItemSync/)
    assert.match(
        singleSettlementWrites,
        /grantCarnivalRewards\([\s\S]*standardRewardGrant: standardRewardGrant\.forCarnival/,
    )
    assert.doesNotMatch(
        singleSettlementWrites,
        /grantCarnivalRewards\([\s\S]*giveItem:/,
    )
    const missionRewardGranter = fs.readFileSync(
        path.join(projectRoot, "src/lib/mission/grants.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        missionRewardGranter,
        /data\/domains\/item/,
    )
    assert.match(
        missionRewardGranter,
        /executeRewardGrantPlanInTransactionOwnerSync\([\s\S]*this\.playerId[\s\S]*knownPlayerBefore[\s\S]*playerUpdate/,
    )
    assert.doesNotMatch(
        missionRewardGranter,
        /item-cap-plan|event-trade|mana-capacity|domains\/mail|getDb\(\)\.transaction|SAVEPOINT/,
    )

    const legacyQuest = fs.readFileSync(path.join(projectRoot, "src/lib/quest.ts"), "utf8")
    const legacyQuestAdapter = fs.readFileSync(
        path.join(projectRoot, "src/lib/quest/legacy-quest-reward-grant.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        legacyQuest,
        /data\/domains\/(?:item|character)|\.\/character|\.\/equipment|\b(?:givePlayerCharacterSync|givePlayerEquipmentSync|updatePlayerSync)\b/,
    )
    assert.match(
        legacyQuestAdapter,
        /executeRewardGrantPlanInTransactionOwnerInternalSync\s*\(/,
    )
    assert.doesNotMatch(
        legacyQuestAdapter,
        /item-cap-plan|event-trade|mana-capacity|domains\/mail|getDb\(\)\.transaction|SAVEPOINT/,
    )

    const readers = fs.readFileSync(path.join(projectRoot, "src/data/domains/item.ts"), "utf8")
    assert.deepEqual(
        [...readers.matchAll(/export function (\w+)/g)].map(match => match[1]),
        [
            "getPlayerItemSync",
            "getPlayerItemsSync",
            "getPlayerItemsByIdsSync",
            "getPlayerCollectedItemTotalSync",
            "getPlayerCollectedItemTotalsSync",
            "getPlayerCollectedItemTotalsByIdsSync",
        ],
    )
})

test("caller-verified late migration paths establish transaction-local Player existence", () => {
    const shop = fs.readFileSync(path.join(projectRoot, "src/routes/api/shop.ts"), "utf8")
    const equipmentEnhancementTransaction = shop.match(
        /\/\/ Equipment enhancement shop:[\s\S]*?getDb\(\)\.transaction\(\(\) => \{([\s\S]*?)\n\s*\}\)\(\)/,
    )?.[1]
    assert.ok(equipmentEnhancementTransaction)
    assert.match(
        equipmentEnhancementTransaction,
        /const currentPlayer = getPlayerSync\(playerId\)[\s\S]*withShopInventorySync\(/,
    )

    const scheduled = fs.readFileSync(
        path.join(projectRoot, "src/lib/scheduled-resource-settlement.ts"),
        "utf8",
    )
    assert.match(
        scheduled,
        /getDb\(\)\.transaction\(\(\) => \{[\s\S]*const currentPlayer = getPlayerSync\(input\.player\.id\)[\s\S]*executeRewardGrantExecutionPlanAsTransactionOwnerSync\([\s\S]*currentPlayer\.freeMana/,
    )
})

test("production Item direct SQL stays inside the final persistence whitelist", () => {
    const sourceRoot = path.join(projectRoot, "src")
    const directMutation = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+players_(?:items|collected_items)/i
    const directSqlFiles = []
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(absolute)
            else if (entry.isFile() && entry.name.endsWith(".ts")
                && directMutation.test(fs.readFileSync(absolute, "utf8"))) {
                directSqlFiles.push(path.relative(projectRoot, absolute))
            }
        }
    }
    visit(sourceRoot)

    assert.deepEqual(directSqlFiles.sort(), [
        "src/data/domains/item-maintenance.ts",
        "src/lib/inventory/sqlite-repository.ts",
    ])

    const fixture = fs.readFileSync(
        path.join(projectRoot, "tools/helpers/inventory-fixture.cjs"),
        "utf8",
    )
    assert.match(fixture, /getDb\(\)\.inTransaction/)
    assert.match(fixture, /grantInventoryItemWithinTransactionSync/)
    assert.match(fixture, /grantInventoryItemSync/)
    assert.match(fixture, /setPlayerItemForMaintenanceSync/)
})
