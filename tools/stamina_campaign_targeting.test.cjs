"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, test } = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stamina-campaign-targeting-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const { initializeDatabase, closeDatabase } = require("../src/data")
const { QuestCategory } = require("../src/lib/types")
const { getActiveCampaignRate } = require("../src/lib/stamina-campaign")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

// ServerDate comfortably inside every fixture window regardless of host TZ.
const IN_WINDOW = new Date("2024-08-14T12:00:00.000Z")
const BEFORE_WINDOW = new Date("2024-01-01T00:00:00.000Z")

function campaignRow({ rate, questType, events = "(None)", mid = "(None)", quests = "(None)",
    start = "2024-08-01 00:00:00", end = "2024-12-31 23:59:59" }) {
    return [["0", start, end, "", "", String(rate), String(questType), events, mid, quests]]
}

function withCampaignTable(table) {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { "stamina_campaign.json": table },
    })
}

initializeDatabase()

test("challenge dungeon campaign discounts only its event and quest selectors", () => {
    withCampaignTable({
        "990001": campaignRow({
            rate: 0.5, questType: 7, events: "1", mid: "", quests: "2",
        }),
    })
    try {
        // Challenge dungeon quest ids decompose as [event ordinal, quest ordinal]
        // by 1000: 1002 = event 1, quest 2.
        assert.equal(
            getActiveCampaignRate(QuestCategory.CHALLENGE_DUNGEON_EVENT, 1002, IN_WINDOW),
            0.5,
        )
        assert.equal(
            getActiveCampaignRate(QuestCategory.CHALLENGE_DUNGEON_EVENT, 1003, IN_WINDOW),
            1,
            "same event, different quest ordinal must not be discounted",
        )
        assert.equal(
            getActiveCampaignRate(QuestCategory.CHALLENGE_DUNGEON_EVENT, 2002, IN_WINDOW),
            1,
            "different event ordinal must not be discounted",
        )
        assert.equal(
            getActiveCampaignRate(QuestCategory.DAILY_WEEK_EVENT, 1002, IN_WINDOW),
            1,
            "different quest type must not be discounted",
        )
    } finally {
        withCampaignTable({})
    }
})

test("boss battle campaign matches the full chapter/node/quest path", () => {
    withCampaignTable({
        "990002": campaignRow({ rate: 0.5, questType: 2, events: "1", mid: "2", quests: "3" }),
    })
    try {
        // Boss battle quest ids decompose by 1000 twice: 1002003 = [1, 2, 3].
        assert.equal(getActiveCampaignRate(QuestCategory.BOSS_BATTLE, 1002003, IN_WINDOW), 0.5)
        assert.equal(
            getActiveCampaignRate(QuestCategory.BOSS_BATTLE, 1002004, IN_WINDOW),
            1,
            "different quest level must not be discounted",
        )
        assert.equal(
            getActiveCampaignRate(QuestCategory.BOSS_BATTLE, 1001003, IN_WINDOW),
            1,
            "different node level must not be discounted",
        )
    } finally {
        withCampaignTable({})
    }
})

test("type-wide campaign rows keep discounting the whole quest type", () => {
    withCampaignTable({
        "990003": campaignRow({ rate: 0.75, questType: 0 }),
        "990004": campaignRow({ rate: 0.5, questType: 0 }),
    })
    try {
        assert.equal(getActiveCampaignRate(QuestCategory.MAIN, 1001002, IN_WINDOW), 0.5)
        assert.equal(getActiveCampaignRate(QuestCategory.MAIN, 999999, IN_WINDOW), 0.5)
        assert.equal(getActiveCampaignRate(QuestCategory.EX, 1001002, IN_WINDOW), 1)
        assert.equal(getActiveCampaignRate(QuestCategory.MAIN, 1001002, BEFORE_WINDOW), 1)
    } finally {
        withCampaignTable({})
    }
})

test("rush campaigns apply through the entry cost with the same selectors", () => {
    withCampaignTable({
        // Rush quest 700007001 decomposes to event ordinal 700007, quest 1.
        "990005": campaignRow({ rate: 0.5, questType: 17, events: "700007", quests: "1" }),
    })
    try {
        assert.equal(getActiveCampaignRate(QuestCategory.RUSH_EVENT, 700007001, IN_WINDOW), 0.5)
        assert.equal(getActiveCampaignRate(QuestCategory.RUSH_EVENT, 700007002, IN_WINDOW), 1)
        assert.equal(getActiveCampaignRate(QuestCategory.RUSH_EVENT, 700011001, IN_WINDOW), 1)
    } finally {
        withCampaignTable({})
    }
})

after(() => {
    closeDatabase()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
