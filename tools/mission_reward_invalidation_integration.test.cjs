"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-reward-real-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, getPlayerItemsSync } = require("../src/data/domains/item")
const { getPlayerPassCardStateSync } = require("../src/data/domains/pass-card")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { getDb } = require("../src/data/db")
const { getCharacterDataSync } = require("../src/lib/assets")
const bundledCharacters = require("../assets/character.json")
const { givePlayerCharacterSync } = require("../src/lib/character")
const { MissionRewardGranter } = require("../src/lib/mission/grants")
const { getFactKeyId } = require("../src/lib/mission/facts/fact-key")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-reward-real-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

function findDupeEligibleCharacter() {
    for (const [rawId, data] of Object.entries(bundledCharacters)) {
        if (data.rarity >= 3 && data.element !== undefined) return Number(rawId)
    }
    throw new Error("No duplicate-reward character in the test catalog")
}

test("real duplicate character reward invalidates characters and the generated item facts", () => {
    const characterId = findDupeEligibleCharacter()
    assert.ok(getCharacterDataSync(characterId))
    assert.ok(givePlayerCharacterSync(playerId, characterId))

    const beforeCharacter = getPlayerCharacterSync(playerId, characterId)
    const beforeItems = getPlayerItemsSync(playerId)
    const granter = new MissionRewardGranter(playerId, getPlayerSync(playerId))
    granter.grant([{ kind: 4, characterId, amount: 1 }])

    const afterCharacter = getPlayerCharacterSync(playerId, characterId)
    const changedItems = Object.entries(getPlayerItemsSync(playerId)).filter(([itemId, amount]) => (
        amount !== beforeItems[itemId]
    ))
    assert.equal(afterCharacter.stack, beforeCharacter.stack + 1)
    assert.equal(changedItems.length, 1)

    const [itemId] = changedItems[0]
    assert.deepEqual(
        granter.invalidatedFactKeys.map(getFactKeyId).sort(),
        ["characters", "collectedItems:" + itemId, "items"].sort(),
    )
})

test("real Pass point writes invalidate only when passState changes", () => {
    const changed = new MissionRewardGranter(playerId, getPlayerSync(playerId))
    changed.grant([{ kind: 7, amount: 10 }], { passCardEventId: 3 })
    assert.equal(getPlayerPassCardStateSync(playerId, 3).point, 10)
    assert.deepEqual(changed.invalidatedFactKeys.map(getFactKeyId), ["passState:3"])

    db.prepare(`
        UPDATE players_pass_cards SET point = 6000
        WHERE player_id = ? AND event_id = 3
    `).run(playerId)
    const capped = new MissionRewardGranter(playerId, getPlayerSync(playerId))
    capped.grant([{ kind: 7, amount: 10 }], { passCardEventId: 3 })
    assert.equal(getPlayerPassCardStateSync(playerId, 3).point, 6000)
    assert.deepEqual(capped.invalidatedFactKeys, [])
})

test.after(() => {
    restoreContentSnapshot()
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
