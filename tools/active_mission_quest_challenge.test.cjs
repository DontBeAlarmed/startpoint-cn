require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-challenge-db-"))
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
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getActiveMissionPracticeQuestChallengeCountSync,
} = require("../src/data/domains/active_mission_counters")
const {
    recordActiveMissionQuestChallengeFactSync,
} = require("../src/lib/mission/active-entry-facts")
const {
    computeActiveMissionFactProgress,
} = require("../src/lib/mission/active-reconciliation")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `active-mission-challenge-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

recordActiveMissionQuestChallengeFactSync(playerId, 1)
assert.equal(getActiveMissionPracticeQuestChallengeCountSync(playerId), 0)
recordActiveMissionQuestChallengeFactSync(playerId, 15)
assert.equal(getActiveMissionPracticeQuestChallengeCountSync(playerId), 1)

assert.throws(() => db.transaction(() => {
    recordActiveMissionQuestChallengeFactSync(playerId, 15)
    throw new Error("rollback challenge fact")
})(), /rollback challenge fact/)
assert.equal(getActiveMissionPracticeQuestChallengeCountSync(playerId), 1)

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {},
    finishedQuestIds: new Set(),
    questProgress: [],
    chapterQuestIds: {},
    practiceQuestChallengeCount: 1,
    characterStoryQuestIds: {},
    characters: {},
    equipment: [],
    manaNodes: {},
    manaBoardNodes: {},
    manaNodeSlots: {},
    partyAbilitySoulCount: 0,
    treasureShopPurchaseCount: 0,
    bossCoinShopPurchaseCount: 0,
    bossCoinEquipmentShopPurchaseCount: 0,
    totalUsedManaCount: 0,
    totalGachaCharacterCount: 0,
    totalEquipmentEquipCount: 0,
    totalUnisonSetCount: 0,
    totalPartyCharacterSetCount: 0,
    totalInjectedExpCount: 0,
    totalGachaCampaignCount: 0,
}
const practiceRow = []
practiceRow[34] = "11"
assert.equal(computeActiveMissionFactProgress(65, practiceRow, state), 1)
const unsupportedRow = []
unsupportedRow[34] = "0"
assert.equal(computeActiveMissionFactProgress(65, unsupportedRow, state), null)
const emptyKindRow = []
emptyKindRow[34] = ""
assert.equal(computeActiveMissionFactProgress(65, emptyKindRow, state), null)

const routeSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
assert.match(routeSource, /recordActiveMissionQuestChallengeFactSync\(playerId, category\)/)

console.log("active mission quest challenge tests passed")
cleanup()
process.removeListener("exit", cleanup)
