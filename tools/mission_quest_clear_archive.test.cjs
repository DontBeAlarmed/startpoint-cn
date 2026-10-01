"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quest-clear-archive-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const { initializeDatabase, closeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
initializeDatabase()
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerQuestClearCountsSync,
    incrementPlayerQuestMultiClearSync,
    incrementPlayerQuestSingleClearSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const {
    writeSingleQuestProgressWithinTransactionSync,
} = require("../src/lib/quest/finish/single-quest-progress-write")
const {
    translateMissionQuestRange,
} = require("../src/lib/mission/quest-range-translator")
const {
    sumArchiveQuestClearCountsSync,
} = require("../src/lib/mission/quest-clear-archive")

process.once("exit", () => {
    closeDatabase()
    restoreContentSnapshot()
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test.after(() => {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

let nextAccount = 0
function newPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "quest-clear-archive",
        idpId: `archive-${nextAccount++}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function seedQuestProgress(playerId, section, questId, finished) {
    insertPlayerQuestProgressSync(playerId, section, {
        questId,
        finished,
        unlocked: true,
        highScore: 1000,
        clearRank: 5,
        bestElapsedTimeMs: 5000,
    })
}

test("schema migration adds single_clear_count and backfills the finished lower bound", () => {
    const database = getDb()
    const columns = database.prepare("PRAGMA table_info(players_quest_progress)").all()
        .map(column => column.name)
    assert.equal(columns.includes("single_clear_count"), true)
    assert.equal(columns.includes("multi_clear_count"), true)

    const playerId = newPlayer()
    seedQuestProgress(playerId, 1, 1001001, true)
    seedQuestProgress(playerId, 1, 1001002, false)

    // Simulate rows that predate the column (or restores of old saves):
    // the initializer's backfill must pin finished rows to the >=1 bound.
    database.prepare(`
        UPDATE players_quest_progress SET single_clear_count = 0 WHERE player_id = ?
    `).run(playerId)
    closeDatabase()
    initializeDatabase()
    const counts = getPlayerQuestClearCountsSync(playerId, [1])
    assert.deepEqual(
        counts.map(row => [row.questId, row.singleClearCount]),
        [[1001001, 1], [1001002, 0]],
    )

    // Idempotent: a second reopen does not push the finished row further.
    closeDatabase()
    initializeDatabase()
    assert.deepEqual(
        getPlayerQuestClearCountsSync(playerId, [1])
            .map(row => [row.questId, row.singleClearCount]),
        [[1001001, 1], [1001002, 0]],
    )
})

test("single finish write path counts repeat clears and skips failed quests", () => {
    const playerId = newPlayer()

    const wrote = writeSingleQuestProgressWithinTransactionSync({
        playerId,
        questCategory: 1,
        questAccomplished: true,
        questId: 1001001,
        clearTime: 4000,
        score: 2000,
        clearRank: 5,
        leaderCharacterId: null,
        existing: null,
    })
    assert.equal(wrote, true)

    const repeat = writeSingleQuestProgressWithinTransactionSync({
        playerId,
        questCategory: 1,
        questAccomplished: true,
        questId: 1001001,
        clearTime: 6000,
        score: 1500,
        clearRank: 4,
        leaderCharacterId: null,
        existing: { bestElapsedTimeMs: 4000, highScore: 2000, clearRank: 5 },
    })
    assert.equal(repeat, true)

    const failed = writeSingleQuestProgressWithinTransactionSync({
        playerId,
        questCategory: 1,
        questAccomplished: false,
        questId: 1001001,
        clearTime: 9000,
        score: 0,
        clearRank: null,
        leaderCharacterId: null,
        existing: { bestElapsedTimeMs: 4000, highScore: 2000, clearRank: 5 },
    })
    assert.equal(failed, false)

    assert.deepEqual(
        getPlayerQuestClearCountsSync(playerId, [1]),
        [{ section: 1, questId: 1001001, singleClearCount: 2, multiClearCount: 0 }],
    )
})

test("archive sums honor range sections, selectors, and battle mode", () => {
    const playerId = newPlayer()
    // Main chapter 1: two quests cleared through the real write path
    // (repeat clears accumulate); multi clears ride along.
    function singleFinish(section, questId, times) {
        let existing = null
        for (let round = 0; round < times; round++) {
            writeSingleQuestProgressWithinTransactionSync({
                playerId,
                questCategory: section,
                questAccomplished: true,
                questId,
                clearTime: 5000,
                score: 1000,
                clearRank: 5,
                leaderCharacterId: null,
                existing,
            })
            existing = { bestElapsedTimeMs: 5000, highScore: 1000, clearRank: 5 }
        }
    }
    singleFinish(1, 1001001, 3)
    singleFinish(1, 1001002, 1)
    singleFinish(4, 4001001, 1) // EX quest, section 4
    incrementPlayerQuestMultiClearSync(playerId, 1, 1001002) // multi → 1
    incrementPlayerQuestMultiClearSync(playerId, 4, 4001001) // multi → 1

    // Range kind 0 (main) with world selector 1: sections [1], triple keys;
    // both archived main quests live in world 1.
    const mainChapter1 = translateMissionQuestRange(["", "", "", "", "", "", "", "0", "1", "(None)", "(None)"])
    assert.notEqual(mainChapter1, null)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, mainChapter1, "single"), 4)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, mainChapter1, "multi"), 1)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, mainChapter1, "any"), 5)

    // Range kind 1 (EX) sees only the EX row regardless of main counts.
    const exRange = translateMissionQuestRange(["", "", "", "", "", "", "", "1", "(None)", "(None)", "(None)"])
    assert.notEqual(exRange, null)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, exRange, "any"), 2)

    // A selector that matches no archived quest sums zero (fail-safe floor).
    const emptyChapter = translateMissionQuestRange(["", "", "", "", "", "", "", "0", "9", "(None)", "(None)"])
    assert.notEqual(emptyChapter, null)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, emptyChapter, "any"), 0)

    // Unconstrained range (no kind): every archived clear counts.
    const unconstrained = translateMissionQuestRange(["", "", "", "", "", "", "", "(None)", "", "", ""])
    assert.notEqual(unconstrained, null)
    assert.equal(unconstrained.unconstrained, true)
    assert.equal(sumArchiveQuestClearCountsSync(playerId, unconstrained, "any"), 7)
})

test("malformed progress counters read as zero instead of poisoning sums", () => {
    const playerId = newPlayer()
    seedQuestProgress(playerId, 1, 1001001, true)
    const database = getDb()
    database.prepare(`
        UPDATE players_quest_progress
        SET single_clear_count = 'corrupt', multi_clear_count = -3
        WHERE player_id = ? AND section = 1 AND quest_id = 1001001
    `).run(playerId)
    const unconstrained = translateMissionQuestRange(["", "", "", "", "", "", "", "(None)", "", "", ""])
    assert.equal(sumArchiveQuestClearCountsSync(playerId, unconstrained, "any"), 0)
})
