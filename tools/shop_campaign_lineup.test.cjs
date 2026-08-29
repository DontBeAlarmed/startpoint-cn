"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-campaign-lineup-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerShopCampaignLineupSync,
    getPlayerShopCampaignLineupsSync,
    selectPlayerShopCampaignLineupSync,
} = require("../src/data/domains/shop-campaign-lineup")
const {
    ShopCampaignPeriodError,
    ShopCampaignValidationError,
    requireAvailableShopCampaign,
    isShopItemVisibleForCampaign,
} = require("../src/lib/shop-select-campaign")

db = initializeDatabase()
assert.equal(db.pragma("user_version", { simple: true }), 22)

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `shop-campaign-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

assert.equal(getPlayerShopCampaignLineupSync(playerId, 4, 10), null)
assert.equal(selectPlayerShopCampaignLineupSync(playerId, 4, 10, 1010), "inserted")
assert.equal(selectPlayerShopCampaignLineupSync(playerId, 4, 10, 1010), "unchanged")
assert.equal(selectPlayerShopCampaignLineupSync(playerId, 4, 10, 1020), "conflict")
assert.equal(getPlayerShopCampaignLineupSync(playerId, 4, 10), 1010)
assert.deepEqual(getPlayerShopCampaignLineupsSync(playerId), { "4:10": 1010 })

const campaigns = {
    "4": {
        "10": {
            availableFrom: "2023-01-01 12:00:00",
            availableUntil: "2023-01-02 11:59:59",
            lineupIds: [1010, 1020],
        },
    },
    "7": {},
}
const periodStart = Date.parse("2023-01-01T12:00:00+08:00")
const periodEnd = Date.parse("2023-01-02T11:59:59+08:00")
assert.equal(requireAvailableShopCampaign(campaigns, 4, 10, 1010, periodStart).lineupIds[0], 1010)
assert.doesNotThrow(() => requireAvailableShopCampaign(campaigns, 4, 10, 1020, periodEnd))
assert.throws(
    () => requireAvailableShopCampaign(campaigns, 4, 10, 9999, periodStart),
    ShopCampaignValidationError,
)
assert.throws(
    () => requireAvailableShopCampaign(campaigns, 4, 10, null, periodEnd + 1),
    ShopCampaignPeriodError,
)
assert.throws(
    () => requireAvailableShopCampaign(campaigns, 7, 10, null, periodStart),
    ShopCampaignValidationError,
)

const selected = { "4:10": 1010 }
assert.equal(isShopItemVisibleForCampaign({}, 4, selected), true)
assert.equal(isShopItemVisibleForCampaign({ campaignId: 10 }, 4, selected), true)
assert.equal(isShopItemVisibleForCampaign({ campaignId: 10, lineupId: 1010 }, 4, selected), true)
assert.equal(isShopItemVisibleForCampaign({ campaignId: 10, lineupId: 1020 }, 4, selected), false)
assert.equal(isShopItemVisibleForCampaign({ campaignId: 10, lineupId: 1010 }, 4, {}), false)
assert.equal(isShopItemVisibleForCampaign({ lineupId: 1010 }, 4, selected), false)

cleanup()
process.removeListener("exit", cleanup)
console.log("shop campaign lineup tests passed")
