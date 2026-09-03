"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const targetCoreFiles = [
    "execution-assets.ts",
    "execution-contract.ts",
    "execution-engine.ts",
    "execution-outcome.ts",
    "execution-plan.ts",
    "execution-result.ts",
    "snapshot.ts",
    "transaction-executor.ts",
]
const removedCoreFiles = [
    "plan.ts",
    "types.ts",
    "executor.ts",
    "entry-result.ts",
    "owner-executor.ts",
    "owner-currency.ts",
    "known-player.ts",
    "inventory-adapter.ts",
]
const sourceAdapters = [
    "src/lib/mail-reward-grant.ts",
    "src/lib/shop-reward-grant.ts",
    "src/lib/gacha-reward-grant.ts",
    "src/lib/box-gacha-reward-grant.ts",
    "src/lib/story-reward-grant.ts",
    "src/lib/raid-event-reward-grant.ts",
    "src/multi/settlement/reward-grant.ts",
]

function read(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

function productionTsFiles() {
    const root = path.join(projectRoot, "src")
    const files = []
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(absolute)
            else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute)
        }
    }
    visit(root)
    return files
}

test("target RewardGrant core exists and migration-only files are gone", () => {
    for (const file of targetCoreFiles) {
        assert.equal(fs.existsSync(path.join(projectRoot, "src/lib/reward-grant", file)), true, file)
    }
    for (const file of removedCoreFiles) {
        assert.equal(fs.existsSync(path.join(projectRoot, "src/lib/reward-grant", file)), false, file)
    }
    assert.equal(fs.existsSync(path.join(projectRoot, "src/lib/quest.ts")), false)
    assert.equal(fs.existsSync(path.join(projectRoot, "src/lib/quest/legacy-quest-reward-grant.ts")), false)
    assert.equal(fs.existsSync(path.join(projectRoot, "src/lib/gacha-reward-legacy.ts")), false)
})

test("public RewardGrant barrel exposes only the target typed contract", () => {
    const index = read("src/lib/reward-grant/index.ts")
    assert.match(index, /export \* from "\.\/execution-contract"/)
    assert.match(index, /export \* from "\.\/execution-plan"/)
    assert.match(index, /export \* from "\.\/execution-result"/)
    assert.match(index, /export \* from "\.\/transaction-executor"/)
    assert.doesNotMatch(index, /\.\/executor|\.\/plan|\.\/types|owner-executor|entry-result/)
    assert.match(read("src/lib/reward-grant/execution-plan.ts"), /createRewardGrantExecutionPlan/)
    assert.match(read("src/lib/reward-grant/transaction-executor.ts"), /executeRewardGrantExecutionPlanSync/)
})

test("production consumers use the public barrel and contain no legacy result fields", () => {
    const forbidden = /reward-grant\/(?:executor|plan|types|entry-result|owner-executor|owner-currency|known-player|inventory-adapter)|\b(?:createRewardGrantPlan|RewardGrantPlan|RewardGrantResult|RewardGrantPlayerAfter|InternalRewardGrantResult|InternalRewardGrantEntryResult|itemDeltas|givePlayerRewardSync|givePlayerRewardsSync|givePlayerScoreRewardsSync|rewardPlayerGachaDrawResultLegacySync)\b/
    for (const file of productionTsFiles()) {
        const relative = path.relative(projectRoot, file)
        if (relative.startsWith("src/legacy/")) continue
        assert.doesNotMatch(read(relative), forbidden, relative)
    }
})

test("production consumers cannot import RewardGrant target internals directly", () => {
    const directTargetImport = /(?:from\s*["'][^"']*reward-grant\/(?:execution-(?:assets|contract|engine|outcome|plan|result)|snapshot|transaction-executor)|require\(\s*["'][^"']*reward-grant\/(?:execution-(?:assets|contract|engine|outcome|plan|result)|snapshot|transaction-executor))/
    for (const file of productionTsFiles()) {
        const relative = path.relative(projectRoot, file)
        if (relative.startsWith("src/legacy/") || relative.startsWith("src/lib/reward-grant/")) continue
        assert.doesNotMatch(read(relative), directTargetImport, relative)
    }
})

test("target core keeps dependency direction below source domains", () => {
    const forbidden = /(?:\/mission|\/quest|\/shop|\/gacha|\/mail|\/story|\/raid|\/multi|\/routes|carnival)/
    for (const file of targetCoreFiles) {
        assert.doesNotMatch(read(path.join("src/lib/reward-grant", file)), forbidden, file)
    }
})

test("source-local reward adapters remain explicit and do not become a common projector", () => {
    for (const file of sourceAdapters) {
        const source = read(file)
        assert.match(source, /RewardGrantExecutionPlan|RewardGrantExecutionResult/, file)
    }
    assert.doesNotMatch(read("src/lib/reward-grant/execution-engine.ts"), /PlayerRewardResult|user_info|character_list|equipment_list/)
})

console.log("reward grant architecture tests loaded")
