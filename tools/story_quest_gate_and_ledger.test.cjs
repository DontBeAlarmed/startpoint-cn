"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-gate-ledger-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerQuestProgressSync, getPlayerSingleQuestProgressSync } = require("../src/data/domains/quest")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getPlayerItemSync } = require("../src/data/domains/item")
const storyRoutes = require("../src/routes/api/storyQuest").default
const questUnlockRoutes = require("../src/routes/api/questUnlock").default

// Main story quest 2-9-7 is a pure story clear (the existing story suite
// finishes it through the story route). Regular mission 11
// (chapter_2_normal_clear_stone) completes when every chapter 2 main quest is
// finished, so seeding the other 28 and story-clearing this one probes the
// MAIN ledger path end to end. Its stage 1 reward is 150 star stones.
const STORY_QUEST_ID = 2009007
const STORY_QUEST_CHAPTER = 2
const CHAPTER_MISSION_ID = 11
const CHAPTER_MISSION_REWARD_ID = 11001
const CHAPTER_MISSION_REWARD_STONE = 150

const UNLOCK_QUEST_CATEGORY = 18
const UNLOCK_QUEST_ID = 400001102
const UNLOCK_ITEM_ID = 60001

// Window anchors are absolute calendar dates, so they stay valid whether or
// not the suite runs with the frozen CN server offset.
const EXPIRED_WINDOW = {
    availableFromMs: Date.parse("2020-01-01T00:00:00Z"),
    availableUntilMs: Date.parse("2020-02-01T00:00:00Z"),
}

function questTableWithWindow(tableName, questId, window) {
    const table = structuredClone(require(`../assets/${tableName}.json`))
    table[String(questId)] = {
        ...table[String(questId)],
        ...window,
    }
    return table
}

function withExpiredMainQuestWindow() {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: {
            "main_quest.json": questTableWithWindow("main_quest", STORY_QUEST_ID, EXPIRED_WINDOW),
        },
    })
}

function chapterQuestIdsExceptStoryQuest() {
    return Object.keys(require("../assets/main_quest.json"))
        .map(Number)
        .filter(questId => Math.floor(questId / 1_000_000) === STORY_QUEST_CHAPTER
            && questId !== STORY_QUEST_ID)
        .sort((left, right) => left - right)
}

function resetSnapshot() {
    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot()
}

initializeDatabase()

let app
async function createPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `story-gate-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 820000000 + sequence
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function storyFinish(app_, viewerId, questId, pathName) {
    return app_.inject({
        method: "POST",
        url: pathName,
        payload: {
            category: 1,
            quest_id: questId,
            party_id: 1,
            viewer_id: viewerId,
            api_count: 1,
        },
    })
}

test("story finish rejects out-of-period quests with 4050 and no side effects", async () => {
    app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(storyRoutes, { prefix: "/story" })
    await app.ready()

    withExpiredMainQuestWindow()
    const { playerId, viewerId } = await createPlayer(1)

    for (const pathName of ["/story/finish", "/story/finish_with_skip"]) {
        const response = await storyFinish(app, viewerId, STORY_QUEST_ID, pathName)
        assert.equal(response.statusCode, 200, response.body)
        const decoded = decode(response)
        assert.equal(decoded.data_headers.result_code, 4050)
        assert.deepEqual(decoded.data, {})
    }

    assert.equal(
        Boolean(getPlayerSingleQuestProgressSync(playerId, 1, STORY_QUEST_ID)?.finished),
        false,
        "expired story finish must not persist quest progress",
    )
    resetSnapshot()
})

test("main story first clear settles the category 1 ledger in the same transaction", async () => {
    const { playerId, viewerId } = await createPlayer(2)
    const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
    for (const questId of chapterQuestIdsExceptStoryQuest()) {
        insertPlayerQuestProgressSync(playerId, 1, { questId, finished: true })
    }
    const playerBefore = getPlayerSync(playerId)
    assert.ok(playerBefore)

    const first = await storyFinish(app, viewerId, STORY_QUEST_ID, "/story/finish")
    assert.equal(first.statusCode, 200, first.body)
    const firstData = decode(first).data
    assert.equal(decode(first).data_headers.result_code, 1)

    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, 1, STORY_QUEST_ID)?.finished,
        true,
        "story finish must persist the quest clear",
    )
    const chapterMissionInfo = firstData.mission_info?.find(entry => (
        entry.mission_category_id === 1 && entry.mission_id === CHAPTER_MISSION_ID
    ))
    assert.deepEqual(chapterMissionInfo, {
        mission_category_id: 1,
        mission_id: CHAPTER_MISSION_ID,
        mission_reward_id: CHAPTER_MISSION_REWARD_ID,
    }, "chapter 2 mission must complete in the story finish response")
    // Seeding the chapter also completes the two chapter 2 boss-defeat count
    // missions (45 -> 30 stones, 46 -> 50 stones) in the same settlement.
    assert.equal(
        firstData.mission_info?.filter(entry => entry.mission_category_id === 1).length >= 3,
        true,
        "chapter count missions must settle together with the chapter mission",
    )
    // 230 石(任务 11 + 45 + 46)+ 级联轮 10 石(player 族达标)
    // = 240 石;官方依次结算语义(2026-10-03 级联批准)
    assert.equal(
        getPlayerSync(playerId).freeVmoney - playerBefore.freeVmoney,
        240,
        "chapter mission and count mission stones must be granted in the same transaction",
    )

    const repeated = await storyFinish(app, viewerId, STORY_QUEST_ID, "/story/finish")
    assert.equal(repeated.statusCode, 200, repeated.body)
    const repeatedData = decode(repeated).data
    assert.equal(
        Boolean(repeatedData.mission_info?.some(entry => entry.mission_id === CHAPTER_MISSION_ID)),
        false,
        "repeated story finish must not re-grant mission rewards",
    )
    assert.equal(
        getPlayerSync(playerId).freeVmoney - playerBefore.freeVmoney,
        240,
        "repeated story finish must not re-grant stones",
    )
})

test("finish_with_skip shares the same MAIN story ledger path", async () => {
    const { playerId, viewerId } = await createPlayer(3)
    const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
    for (const questId of chapterQuestIdsExceptStoryQuest()) {
        insertPlayerQuestProgressSync(playerId, 1, { questId, finished: true })
    }

    const skipped = await storyFinish(app, viewerId, STORY_QUEST_ID, "/story/finish_with_skip")
    assert.equal(skipped.statusCode, 200, skipped.body)
    const skippedData = decode(skipped).data
    assert.equal(
        Boolean(skippedData.mission_info?.some(entry => (
            entry.mission_category_id === 1 && entry.mission_id === CHAPTER_MISSION_ID
        ))),
        true,
        "skip-and-clear must feed the same mission ledger as a plain clear",
    )
})

test("quest unlock rejects out-of-period quests without burning unlock items", async () => {
    const unlockApp = Fastify({ logger: false })
    unlockApp.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await unlockApp.register(questUnlockRoutes, { prefix: "/quest_unlock" })
    await unlockApp.ready()

    restoreContentSnapshot()
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: {
            "world_story_event_quest.json": questTableWithWindow(
                "world_story_event_quest",
                UNLOCK_QUEST_ID,
                EXPIRED_WINDOW,
            ),
        },
    })
    const { playerId, viewerId } = await createPlayer(4)
    setInventoryFixtureItemExactSync(playerId, UNLOCK_ITEM_ID, 1)

    const response = await unlockApp.inject({
        method: "POST",
        url: "/quest_unlock/unlock",
        payload: {
            viewer_id: viewerId,
            category: UNLOCK_QUEST_CATEGORY,
            quest_id: UNLOCK_QUEST_ID,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
    const decoded = decode(response)
    assert.equal(decoded.data_headers.result_code, 4050)
    assert.deepEqual(decoded.data, {})
    assert.equal(getPlayerItemSync(playerId, UNLOCK_ITEM_ID), 1, "unlock items must not be burned")
    assert.equal(
        Boolean(getPlayerQuestProgressSync(playerId)[String(UNLOCK_QUEST_CATEGORY)]
            ?.some(progress => progress.questId === UNLOCK_QUEST_ID && progress.unlocked)),
        false,
        "expired unlock must not flag the quest as unlocked",
    )
    resetSnapshot()
})

const { after } = require("node:test")

after(() => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
