"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const ownerFiles = [
    "src/routes/api/activeMission.ts",
    "src/routes/api/mail.ts",
    "src/routes/api/shop.ts",
    "src/routes/api/gacha.ts",
    "src/routes/api/storyQuest.ts",
    "src/routes/api/tutorial.ts",
    "src/lib/quest/finish/single-settlement-writes.ts",
    "src/multi/settlement/orchestrator.ts",
]

test("Growth owner publication boundary is available", () => {
    const publication = require("../src/lib/character-growth/owner-publication")
    assert.equal(typeof publication.publishCharacterGrowthOwnerStateBestEffort, "function")
    assert.equal(typeof publication.createCharacterGrowthPublicationContextBestEffort, "function")
})

test("all external Growth owners use the Character Growth publication boundary", () => {
    for (const relativeFile of ownerFiles) {
        const source = fs.readFileSync(path.join(root, relativeFile), "utf8")
        assert.match(source, /publishCharacterGrowthOwnerStateBestEffort/)
        assert.doesNotMatch(source, /awake-best-effort-context/)
        assert.doesNotMatch(source, /reconcileAwakeUnlockCharacterListBestEffort/)
    }
})
