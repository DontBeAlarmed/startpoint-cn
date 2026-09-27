"use strict"

// Focused suite for POST /api/index.php/story_quest/finish and
// /api/index.php/story_quest/finish_with_skip.
//
// GREEN regression suite (2026-09-27 story-finish-category fix, Task 3):
//   The four "[RED]"-labelled positive cases were written in Task 1 to assert
//   the DESIRED end state (HTTP 200 with response data) for pure story nodes of
//   category 7 (ADVENT_EVENT_SINGLE) and 10 (STORY_EVENT_SINGLE) while the
//   baseline whitelist (MAIN(1)/CHARACTER(3) only) still answered HTTP 400.
//   They now pass against the Task 2 whitelist extension WITHOUT any assertion
//   having been flipped. Their names and "must not be flipped" diagnostics are
//   kept as regression history; Task 3 only extends them with first-clear
//   reward, progress and idempotency assertions.
//   Coverage added by Task 3:
//     - content-fact guardrails for the bundled quest/reward tables (fail
//       loudly on snapshot drift instead of failing positives for the wrong
//       reason),
//     - first-clear reward + progress for category 7 (observable reward:
//       character 263009 via clear_reward 100101) and category 10 (progress
//       mandatory; freeVmoney currency grant via clear_reward 1),
//     - idempotency: a repeated finish must answer 200 and produce NO further
//       observable reward/player state change (compared via DB snapshots
//       around each call, not just HTTP status codes),
//     - negative paths: 400 + per-reason message + discriminated "[STORY]"
//       log tag + no quest progress and unchanged observable reward state.
//   Per Step 5, nothing here pins or modifies activity main tables, time
//   windows or availableFromMs data; only the story node classification and
//   clear-reward rows of the existing content tables are pinned.
//
// The first test ports the pre-existing legacy main() coverage verbatim
// (MAIN/CHARACTER story finish, story join characters, mission settlement,
// reward rollback atomicity, town character claims) so it stays green while
// the focused category 7/10 cases run.

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, before, test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-quest-finish-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { insertPlayerCharacterManaNodesSync, updatePlayerCharacterSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync, getPlayerSync } = require("../src/data/domains/player")
const { getPlayerSingleQuestProgressSync } = require("../src/data/domains/quest")
const { getPlayerActiveMissionsSync } = require("../src/data/domains/mission")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const storyRoutes = require("../src/routes/api/storyQuest").default
const characterRoutes = require("../src/routes/api/character").default

const db = initializeDatabase()

// Pure story nodes taken verbatim from the bundled content tables:
// assets/advent_event_quest.json["100002001"]: clearRewardId=100101, no sPlusRewardId.
const ADVENT_PURE_STORY_QUEST_ID = 100002001
// assets/advent_event_quest.json["100002003"]: sPlusRewardId=1 (battle node).
const ADVENT_BATTLE_QUEST_ID = 100002003
// assets/story_event_single_quest.json["100002001"]: clearRewardId=1, no sPlusRewardId.
const STORY_SINGLE_PURE_STORY_QUEST_ID = 100002001
// assets/story_event_single_quest.json["100002007"]: sPlusRewardId=1 (battle node).
const STORY_SINGLE_BATTLE_QUEST_ID = 100002007
// assets/world_story_event_quest.json["100100001"]: clearRewardId=1, no battle fields.
const WORLD_STORY_PURE_STORY_QUEST_ID = 100100001
// assets/world_story_event_quest.json["100100003"]: sPlusRewardId=1 (battle node).
const WORLD_STORY_BATTLE_QUEST_ID = 100100003

const ADVENT_EVENT_SINGLE_CATEGORY = 7 // QuestCategory.ADVENT_EVENT_SINGLE
const STORY_EVENT_SINGLE_CATEGORY = 10 // QuestCategory.STORY_EVENT_SINGLE
const WORLD_STORY_EVENT_CATEGORY = 18 // QuestCategory.WORLD_STORY_EVENT
const UNKNOWN_CATEGORY = 999
const NONEXISTENT_STORY_QUEST_ID = 199999999

// Per-reason failure messages produced by src/routes/api/storyQuest.ts after
// the Task 2 fix (discriminated { ok: false, reason } → 400 body message).
const BATTLE_QUEST_REJECTION_MESSAGE = "Battle quest cannot be finished through story endpoint."
const UNSUPPORTED_CATEGORY_MESSAGE = "Unsupported story quest category."
const QUEST_NOT_FOUND_MESSAGE = "Story quest not found."

// Reward content facts (pinned by the content guardrail test below):
// clear_reward.json["100101"] = { type: 2 (CHARACTER), id: 263009 } — the
// observable first-clear reward of advent quest 100002001.
const ADVENT_CLEAR_REWARD_CHARACTER_ID = 263009
// clear_reward.json["1"] = { type: 3 (BEADS), count: 15 } — RewardType.BEADS is
// granted as the freeVmoney player currency, so category 10's first clear is
// observable as a freeVmoney delta of exactly 15.
const STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY = 15

// Bundled content tables the focused tests rely on (same source of truth the
// gameplay snapshot installer loads). Read-only: the suite never modifies
// content data.
const adventEventQuestTable = require("../assets/advent_event_quest.json")
const storyEventSingleQuestTable = require("../assets/story_event_single_quest.json")
const worldStoryEventQuestTable = require("../assets/world_story_event_quest.json")
const clearRewardTable = require("../assets/clear_reward.json")
const storyJoinCharacterTable = require("../assets/story_join_character.json")

function buildLegacyApp() {
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    app.register(storyRoutes, { prefix: "/story" })
    app.register(characterRoutes, { prefix: "/character" })
    return app
}

function buildFocusedApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
    app.register(storyRoutes, { prefix: "/api/index.php/story_quest" })
    return app
}

const apps = {}

test.before(async () => {
    apps.legacy = buildLegacyApp()
    apps.focused = buildFocusedApp()
    await apps.legacy.ready()
    await apps.focused.ready()
})

test.after(async () => {
    for (const app of Object.values(apps)) await app.close()
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

async function createPlayer(sequence) {
    const viewerId = 810000000 + sequence
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `story-finish-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

// ---------------------------------------------------------------------------
// Ported legacy coverage (was main() in this file before the focused rewrite)
// ---------------------------------------------------------------------------

function decodeLegacy(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function finishLegacy(app, viewerId, questId, pathName = "/story/finish", category = 1) {
    return app.inject({
        method: "POST",
        url: pathName,
        payload: {
            category,
            quest_id: questId,
            party_id: 1,
            viewer_id: viewerId,
            api_count: 1,
        },
    })
}

test("ported legacy coverage: story finish stays green for MAIN/CHARACTER", async () => {
    const app = apps.legacy

    const direct = await createPlayer(1)
    const first = await finishLegacy(app, direct.viewerId, 2009007)
    assert.equal(first.statusCode, 200, first.body)
    const firstData = decodeLegacy(first).data
    assert.equal(Array.isArray(firstData), false)
    assert.deepEqual(firstData.story_join_character_id_list, [10])
    assert.ok(firstData.character_list.some(character => character.character_id === 10))
    assert.deepEqual(firstData.item_list, {})
    assert.equal("items" in firstData, false)
    assert.ok(getPlayerCharacterSync(direct.playerId, 10))

    const repeated = await finishLegacy(app, direct.viewerId, 2009007)
    assert.equal(repeated.statusCode, 200, repeated.body)
    const repeatedData = decodeLegacy(repeated).data
    assert.equal(Array.isArray(repeatedData), false)
    assert.deepEqual(repeatedData.story_join_character_id_list, [])
    assert.deepEqual(repeatedData.character_list, [])
    assert.equal(getPlayerCharacterSync(direct.playerId, 10).stack, 0)

    const ownedStoryCharacter = await createPlayer(7)
    const { givePlayerCharacterSync } = require("../src/lib/character")
    assert.ok(givePlayerCharacterSync(ownedStoryCharacter.playerId, 10)?.character)
    const { getCharacterFacts } = require("../src/lib/character-content")
    const { getCharacterGrowthContent } = require("../src/lib/character-growth-content")
    const getCharacterDataSync = characterId => getCharacterFacts().get(characterId)
    const getCharacterManaNodesSync = (characterId, level) => getCharacterGrowthContent().getManaBoardNodes(characterId, level)
    const { characterExpCaps } = require("../src/lib/character")
    const ownedAsset = getCharacterDataSync(10)
    const ownedManaNodes = getCharacterManaNodesSync(10, 1)
    assert.ok(ownedAsset && ownedManaNodes)
    updatePlayerCharacterSync(
        ownedStoryCharacter.playerId,
        10,
        { exp: characterExpCaps[ownedAsset.rarity][0] },
    )
    insertPlayerCharacterManaNodesSync(
        ownedStoryCharacter.playerId,
        10,
        Object.keys(ownedManaNodes).map(Number),
    )
    const defaultStoryCharacter = getCharacterDataSync(1)
    const defaultStoryManaNodes = getCharacterManaNodesSync(1, 1)
    assert.ok(defaultStoryCharacter && defaultStoryManaNodes)
    updatePlayerCharacterSync(
        ownedStoryCharacter.playerId,
        1,
        { exp: characterExpCaps[defaultStoryCharacter.rarity][0] },
    )
    insertPlayerCharacterManaNodesSync(
        ownedStoryCharacter.playerId,
        1,
        Object.keys(defaultStoryManaNodes).map(Number),
    )
    for (const characterStoryQuestId of [101, 102]) {
        const response = await finishLegacy(
            app,
            ownedStoryCharacter.viewerId,
            characterStoryQuestId,
            "/story/finish",
            3,
        )
        assert.equal(response.statusCode, 200, response.body)
    }
    const ownerPublicationModule = require("../src/lib/character-growth/owner-publication")
    const originalPublishCharacterGrowthOwnerStateBestEffort =
        ownerPublicationModule.publishCharacterGrowthOwnerStateBestEffort
    let observedCandidateCharacterIds
    ownerPublicationModule.publishCharacterGrowthOwnerStateBestEffort = (
        playerId,
        explicitCharacterIds,
        ...rest
    ) => {
        observedCandidateCharacterIds = [...explicitCharacterIds]
        return originalPublishCharacterGrowthOwnerStateBestEffort(playerId, explicitCharacterIds, ...rest)
    }
    let ownedStoryFinish
    try {
        ownedStoryFinish = await finishLegacy(app, ownedStoryCharacter.viewerId, 2009007)
    } finally {
        ownerPublicationModule.publishCharacterGrowthOwnerStateBestEffort =
            originalPublishCharacterGrowthOwnerStateBestEffort
    }
    assert.equal(ownedStoryFinish.statusCode, 200, ownedStoryFinish.body)
    const ownedStoryData = decodeLegacy(ownedStoryFinish).data
    const { createAwakeRequestContext } = require("../src/lib/mission/awake-request-context")
    const debugContext = createAwakeRequestContext({
        playerId: ownedStoryCharacter.playerId,
        candidateCharacterIds: [1],
    })
    assert.deepEqual(observedCandidateCharacterIds, [10])
    assert.deepEqual(
        debugContext.evaluate([1]).find(entry => entry.missionId === 11),
        { missionId: 11, progress: 2 },
    )
    assert.deepEqual(
        ownedStoryData.story_join_character_id_list,
        [],
        "already-owned story character must remain absent from the response grant list",
    )
    assert.deepEqual(
        ownedStoryData.character_list,
        [],
        "evaluated candidates without state changes must not project empty character entries",
    )

    const characterEpisode = await createPlayer(5)
    const characterEpisodeFinish = await finishLegacy(
        app,
        characterEpisode.viewerId,
        101,
        "/story/finish",
        3,
    )
    assert.equal(characterEpisodeFinish.statusCode, 200, characterEpisodeFinish.body)
    const characterEpisodeData = decodeLegacy(characterEpisodeFinish).data
    assert.deepEqual(
        characterEpisodeData.mission_info.filter(entry => (
            entry.mission_category_id === 1 && entry.mission_id === 23
        )),
        [{
            mission_category_id: 1,
            mission_id: 23,
            mission_reward_id: 23001,
        }],
        "普通角色故事任务必须在首次通关响应中完成并发奖",
    )
    assert.deepEqual(
        characterEpisodeData.active_mission_list.find(entry => entry.mission_id === 11010),
        {
            mission_id: 11010,
            progress_value: 1,
            stages: [{ stage: 1, received: false }],
        },
        "角色故事首次完成后必须在同一响应刷新成长任务",
    )
    assert.equal(getPlayerActiveMissionsSync(characterEpisode.playerId)[11010].progress, 1)

    const activeMissionRollback = await createPlayer(6)
    db.exec(`
        CREATE TRIGGER reject_story_active_mission
        BEFORE INSERT ON players_active_missions
        WHEN NEW.player_id = ${activeMissionRollback.playerId} AND NEW.id = 11010
        BEGIN
            SELECT RAISE(ABORT, 'forced story active mission failure');
        END;
    `)
    const failedActiveMission = await finishLegacy(
        app,
        activeMissionRollback.viewerId,
        101,
        "/story/finish",
        3,
    )
    assert.equal(failedActiveMission.statusCode, 500)
    assert.equal(getPlayerSingleQuestProgressSync(activeMissionRollback.playerId, 3, 101), null)
    assert.equal(getPlayerActiveMissionsSync(activeMissionRollback.playerId)[11010], undefined)
    db.exec("DROP TRIGGER reject_story_active_mission")

    const skipped = await createPlayer(2)
    const skipResponse = await finishLegacy(
        app,
        skipped.viewerId,
        10015003,
        "/story/finish_with_skip",
    )
    assert.equal(skipResponse.statusCode, 200, skipResponse.body)
    assert.deepEqual(decodeLegacy(skipResponse).data.story_join_character_id_list, [213013])
    assert.ok(getPlayerCharacterSync(skipped.playerId, 213013))

    const battleCategory = await createPlayer(8)
    const battleCategoryResponse = await finishLegacy(
        app,
        battleCategory.viewerId,
        1001,
        "/story/finish",
        11,
    )
    assert.equal(battleCategoryResponse.statusCode, 400)
    assert.equal(
        getPlayerSingleQuestProgressSync(battleCategory.playerId, 11, 1001),
        null,
        "battle event categories must not enter the story finish path",
    )

    const town = await createPlayer(3)
    const prematureTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 1 },
    })
    assert.equal(prematureTownClaim.statusCode, 400)

    const townUnlock = await finishLegacy(app, town.viewerId, 1008004)
    assert.equal(townUnlock.statusCode, 200, townUnlock.body)
    assert.deepEqual(decodeLegacy(townUnlock).data.story_join_character_id_list, [])
    assert.equal(getPlayerCharacterSync(town.playerId, 512001), null)

    const townClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 2 },
    })
    assert.equal(townClaim.statusCode, 200, townClaim.body)
    assert.ok(getPlayerCharacterSync(town.playerId, 512001))

    const duplicateTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 3 },
    })
    assert.equal(duplicateTownClaim.statusCode, 400)
    assert.equal(getPlayerCharacterSync(town.playerId, 512001).stack, 0)

    const arbitraryTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 213013, viewer_id: town.viewerId, api_count: 4 },
    })
    assert.equal(arbitraryTownClaim.statusCode, 400)

    const rollback = await createPlayer(4)
    db.exec(`
        CREATE TRIGGER reject_story_progress
        BEFORE INSERT ON players_quest_progress
        WHEN NEW.player_id = ${rollback.playerId} AND NEW.quest_id = 10015003
        BEGIN
            SELECT RAISE(ABORT, 'forced story progress failure');
        END;
    `)
    const beforeEquipment = db.prepare(`
        SELECT COUNT(*) AS count FROM players_equipment
        WHERE player_id = ? AND id = 100010
    `).get(rollback.playerId).count
    const failed = await finishLegacy(app, rollback.viewerId, 10015003)
    assert.equal(failed.statusCode, 500)
    assert.equal(getPlayerCharacterSync(rollback.playerId, 213013), null)
    assert.equal(getPlayerSingleQuestProgressSync(rollback.playerId, 1, 10015003), null)
    const afterEquipment = db.prepare(`
        SELECT COUNT(*) AS count FROM players_equipment
        WHERE player_id = ? AND id = 100010
    `).get(rollback.playerId).count
    assert.equal(afterEquipment, beforeEquipment, "奖励和剧情角色必须随进度写入一起回滚")
})

// ---------------------------------------------------------------------------
// Focused category 7/10 coverage (RED at baseline, GREEN after Task 2)
// ---------------------------------------------------------------------------

async function postFocused(url, body) {
    const response = await apps.focused.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
    const contentType = String(response.headers["content-type"] ?? "")
    let decoded
    try {
        decoded = contentType.includes("application/x-msgpack")
            ? unpack(Buffer.from(response.body, "base64"))
            : response.json()
    } catch (error) {
        decoded = { data_headers: {}, data: { body: String(response.body).slice(0, 300) } }
    }
    // `body` is the full decoded envelope for 200 responses ({data_headers,
    // data}) and the JSON error body ({error, message}) for the Task 2 400
    // responses.
    return {
        statusCode: response.statusCode,
        headers: decoded.data_headers,
        data: decoded.data,
        body: decoded,
    }
}

async function focusedFinish(viewerId, questId, category, endpoint = "finish") {
    return postFocused(`/api/index.php/story_quest/${endpoint}`, {
        viewer_id: viewerId,
        api_count: 1,
        party_id: 1,
        quest_id: questId,
        category,
    })
}

// Observable reward/player state: every store a story finish can mutate on the
// reward path (currencies via reward grants, characters via clear-reward
// character grants and story join characters, equipment/items via reward
// grants). deepEqual of two snapshots proves a call had NO reward-visible side
// effects; a compared delta proves the grant actually landed. The plan's
// idempotency and negative-path steps require this observable comparison, not
// just HTTP status codes.
function captureRewardObservableState(playerId) {
    const player = getPlayerSync(playerId)
    assert.ok(player, `player ${playerId} must exist when capturing reward state`)
    return {
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
        characters: db.prepare(`
            SELECT id, stack FROM players_characters WHERE player_id = ? ORDER BY id
        `).all(playerId).map(row => [row.id, row.stack]),
        equipment: db.prepare(`
            SELECT id, stack FROM players_equipment WHERE player_id = ? ORDER BY id
        `).all(playerId).map(row => [row.id, row.stack]),
        items: db.prepare(`
            SELECT id, amount FROM players_items WHERE player_id = ? ORDER BY id
        `).all(playerId).map(row => [row.id, row.amount]),
    }
}

// Reward state without the character rows — used to assert that a reward grant
// changed exactly the expected stores and nothing else.
function rewardStateExceptCharacters(state) {
    return {
        freeMana: state.freeMana,
        freeVmoney: state.freeVmoney,
        expPool: state.expPool,
        equipment: state.equipment,
        items: state.items,
    }
}

// Captures the server's own console.log lines during a focused finish call so
// the negative tests can verify the discriminated failure reasons also show up
// as distinct "[STORY] ..." log semantics (plan Step 4).
async function captureStoryFinishLogs(run) {
    const lines = []
    const originalConsoleLog = console.log
    console.log = (...args) => {
        lines.push(args.map(String).join(" "))
    }
    try {
        return { result: await run(), lines }
    } finally {
        console.log = originalConsoleLog
    }
}

// Content-fact guardrail (Task 1 carry-over): the focused tests below rely on
// these bundled content facts. If a content snapshot refresh drifts, fail here
// with a clear reason instead of making the positive cases fail for the wrong
// reason. Per Step 5, only the story node classification and clear-reward rows
// of the existing content tables are pinned — no activity main table, time
// window or availableFromMs data is asserted on or modified.
test("content guardrail: bundled quest nodes and clear rewards match the focused suite's assumptions", () => {
    const adventPureStory = adventEventQuestTable[String(ADVENT_PURE_STORY_QUEST_ID)]
    assert.deepEqual(
        {
            clearRewardId: adventPureStory?.clearRewardId,
            sPlusRewardId: adventPureStory?.sPlusRewardId,
        },
        { clearRewardId: 100101, sPlusRewardId: undefined },
        "advent_event_quest 100002001 must stay a pure story node "
        + "(clearRewardId 100101, no battle sPlusRewardId)",
    )
    assert.equal(
        adventEventQuestTable[String(ADVENT_BATTLE_QUEST_ID)]?.sPlusRewardId,
        1,
        "advent_event_quest 100002003 must stay a battle node (sPlusRewardId present)",
    )
    const storySinglePureStory = storyEventSingleQuestTable[String(STORY_SINGLE_PURE_STORY_QUEST_ID)]
    assert.deepEqual(
        {
            clearRewardId: storySinglePureStory?.clearRewardId,
            sPlusRewardId: storySinglePureStory?.sPlusRewardId,
        },
        { clearRewardId: 1, sPlusRewardId: undefined },
        "story_event_single_quest 100002001 must stay a pure story node "
        + "(clearRewardId 1, no battle sPlusRewardId)",
    )
    assert.equal(
        storyEventSingleQuestTable[String(STORY_SINGLE_BATTLE_QUEST_ID)]?.sPlusRewardId,
        1,
        "story_event_single_quest 100002007 must stay a battle node (sPlusRewardId present)",
    )
    // World story (category 18) facts: 100100001 is a pure story node whose
    // clear_reward 1 grant is the shared beads/freeVmoney row pinned above;
    // 100100003 is a battle node. 100100001 also exists in
    // world_story_event_boss_battle_quest.json (category 19, battle) — the
    // category-scoped table lookup is what keeps the two apart.
    assert.deepEqual(
        {
            clearRewardId: worldStoryEventQuestTable[String(WORLD_STORY_PURE_STORY_QUEST_ID)]?.clearRewardId,
            sPlusRewardId: worldStoryEventQuestTable[String(WORLD_STORY_PURE_STORY_QUEST_ID)]?.sPlusRewardId,
        },
        { clearRewardId: 1, sPlusRewardId: undefined },
        "world_story_event_quest 100100001 must stay a pure story node "
        + "(clearRewardId 1, no battle sPlusRewardId)",
    )
    assert.equal(
        worldStoryEventQuestTable[String(WORLD_STORY_BATTLE_QUEST_ID)]?.sPlusRewardId,
        1,
        "world_story_event_quest 100100003 must stay a battle node (sPlusRewardId present)",
    )
    // RewardType.CHARACTER=2: clear_reward 100101 grants character 263009 —
    // the observable first-clear reward the category 7 tests assert on.
    assert.deepEqual(
        clearRewardTable["100101"],
        { name: "", type: 2, id: ADVENT_CLEAR_REWARD_CHARACTER_ID },
        "clear_reward 100101 must stay the character 263009 grant",
    )
    // RewardType.BEADS=3: clear_reward 1 grants 15 beads (freeVmoney) — the
    // observable currency grant the category 10 tests assert on.
    assert.deepEqual(
        clearRewardTable["1"],
        { name: "", type: 3, count: STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY },
        "clear_reward 1 must stay the beads/freeVmoney ×15 grant",
    )
    // No quest-type story join characters reference the focused quests, so the
    // idempotency snapshot comparison doubles as the join-character duplicate
    // guard (a content change here would need a dedicated assertion).
    const focusedQuestIds = new Set([
        ADVENT_PURE_STORY_QUEST_ID,
        ADVENT_BATTLE_QUEST_ID,
        STORY_SINGLE_PURE_STORY_QUEST_ID,
        STORY_SINGLE_BATTLE_QUEST_ID,
        WORLD_STORY_PURE_STORY_QUEST_ID,
        WORLD_STORY_BATTLE_QUEST_ID,
    ])
    const joinCharacterQuestIds = Object.values(storyJoinCharacterTable)
        .flatMap(rows => rows.map(row => Number(row[4])))
        .filter(questId => focusedQuestIds.has(questId))
    assert.deepEqual(
        joinCharacterQuestIds,
        [],
        "focused quests must keep zero story join characters (see story_join_character.json)",
    )
})

test("[RED] category 7 pure story node 100002001 finishes via story_quest/finish", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended to "
        + "ADVENT_EVENT_SINGLE(7)/STORY_EVENT_SINGLE(10). Baseline logs "
        + "'[STORY] category is not supported by story finish: category=7' and answers HTTP 400. "
        + "The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(11)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerCharacterSync(playerId, ADVENT_CLEAR_REWARD_CHARACTER_ID),
        null,
        "fresh player must not own the clear_reward 100101 character yet",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID),
        null,
        "fresh player must have no progress row for the advent story node",
    )
    const result = await focusedFinish(viewerId, ADVENT_PURE_STORY_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY)
    assert.equal(
        result.statusCode,
        200,
        `pure story advent node must finish with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish success response must include data")
    // No quest-type story join characters exist for 100002001 (guardrail), and
    // the character-type clear reward must not surface as item_list entries.
    assert.deepEqual(
        result.data.story_join_character_id_list,
        [],
        "advent story node 100002001 must not grant story join characters",
    )
    assert.deepEqual(
        result.data.item_list,
        {},
        "clear_reward 100101 is a character grant and must not produce item_list entries",
    )
    // First-clear reward (plan Step 2): clear_reward 100101 grants character
    // 263009 — assert the grant in the player's observable state.
    assert.ok(
        getPlayerCharacterSync(playerId, ADVENT_CLEAR_REWARD_CHARACTER_ID),
        "first clear must grant clear_reward 100101's character 263009",
    )
    const after = captureRewardObservableState(playerId)
    assert.equal(after.characters.length, before.characters.length + 1, "exactly one character row must be added")
    assert.ok(
        after.characters.some(([characterId]) => characterId === ADVENT_CLEAR_REWARD_CHARACTER_ID),
        "the added character row must be clear_reward 100101's character 263009",
    )
    assert.deepEqual(
        rewardStateExceptCharacters(after),
        rewardStateExceptCharacters(before),
        "character-type clear reward must not change currencies, equipment or items",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID)?.finished,
        true,
        "story finish must mark quest 100002001 finished for category 7",
    )
})

test("[RED] category 7 pure story node 100002001 finishes via story_quest/finish_with_skip", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended; "
        + "baseline answers HTTP 400 ('[STORY] category is not supported by story finish: category=7'). "
        + "The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(12)
    const result = await focusedFinish(
        viewerId,
        ADVENT_PURE_STORY_QUEST_ID,
        ADVENT_EVENT_SINGLE_CATEGORY,
        "finish_with_skip",
    )
    assert.equal(
        result.statusCode,
        200,
        `pure story advent node must finish_with_skip with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish_with_skip success response must include data")
    assert.deepEqual(
        result.data.story_join_character_id_list,
        [],
        "finish_with_skip must not grant story join characters for 100002001",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID)?.finished,
        true,
        "finish_with_skip must mark quest 100002001 finished for category 7",
    )
})

test("[RED] category 10 pure story node 100002001 finishes via story_quest/finish", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended; "
        + "baseline logs '[STORY] category is not supported by story finish: category=10' and answers "
        + "HTTP 400. The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(13)
    const before = captureRewardObservableState(playerId)
    const result = await focusedFinish(viewerId, STORY_SINGLE_PURE_STORY_QUEST_ID, STORY_EVENT_SINGLE_CATEGORY)
    assert.equal(
        result.statusCode,
        200,
        `pure story story_event_single node must finish with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish success response must include data")
    // Mandatory progress assertion (plan Step 2): category 10's clearRewardId 1
    // (beads → freeVmoney) may be content-drifted to a non-observable reward,
    // but finished === true must always hold.
    const progress = getPlayerSingleQuestProgressSync(
        playerId,
        STORY_EVENT_SINGLE_CATEGORY,
        STORY_SINGLE_PURE_STORY_QUEST_ID,
    )
    assert.ok(progress, "story finish must create a progress row for story_event_single 100002001")
    assert.equal(progress.finished, true, "story finish must mark quest 100002001 finished for category 10")
    // Observable reward delta (grounded by the clear_reward 1 guardrail):
    // 15 beads are granted as freeVmoney on first clear.
    const after = captureRewardObservableState(playerId)
    assert.equal(
        after.freeVmoney,
        before.freeVmoney + STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY,
        "first clear must grant clear_reward 1's 15 beads as freeVmoney",
    )
    assert.deepEqual(
        after.characters,
        before.characters,
        "category 10 clear reward must not grant characters",
    )
    assert.deepEqual(
        after.equipment,
        before.equipment,
        "category 10 clear reward must not grant equipment",
    )
    assert.deepEqual(
        after.items,
        before.items,
        "category 10 clear reward must not grant items",
    )
    assert.equal(after.freeMana, before.freeMana, "category 10 clear reward must not change free mana")
    assert.equal(after.expPool, before.expPool, "category 10 clear reward must not change the exp pool")
    assert.equal(
        result.data.user_info.free_vmoney,
        after.freeVmoney,
        "response user_info must reflect the granted freeVmoney",
    )
})

test("[RED] category 10 pure story node 100002001 finishes via story_quest/finish_with_skip", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended; "
        + "baseline answers HTTP 400 ('[STORY] category is not supported by story finish: category=10'). "
        + "The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(14)
    const result = await focusedFinish(
        viewerId,
        STORY_SINGLE_PURE_STORY_QUEST_ID,
        STORY_EVENT_SINGLE_CATEGORY,
        "finish_with_skip",
    )
    assert.equal(
        result.statusCode,
        200,
        `pure story story_event_single node must finish_with_skip with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish_with_skip success response must include data")
    const progress = getPlayerSingleQuestProgressSync(
        playerId,
        STORY_EVENT_SINGLE_CATEGORY,
        STORY_SINGLE_PURE_STORY_QUEST_ID,
    )
    assert.ok(progress, "finish_with_skip must create a progress row for story_event_single 100002001")
    assert.equal(progress.finished, true, "finish_with_skip must mark quest 100002001 finished for category 10")
})

// Step 3: repeating the same finish for the same player/category/quest must be
// idempotent — both calls answer 200, the first call produces the observable
// first-clear reward delta, the second call adds NO further reward and no
// duplicate story join character, and progress stays finished. Observable
// reward/player state is compared around EACH call (not just HTTP status
// codes).

test("category 7 repeat finish of 100002001 is idempotent in observable reward state", async () => {
    const { playerId, viewerId } = await createPlayer(19)
    const beforeFirst = captureRewardObservableState(playerId)

    const firstFinish = await focusedFinish(viewerId, ADVENT_PURE_STORY_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY)
    assert.equal(firstFinish.statusCode, 200, `first finish must succeed: ${JSON.stringify(firstFinish.body)}`)
    assert.ok(firstFinish.data, "first finish response must include data")
    const afterFirst = captureRewardObservableState(playerId)
    assert.equal(
        afterFirst.characters.length,
        beforeFirst.characters.length + 1,
        "first finish must grant exactly the clear_reward 100101 character",
    )
    assert.ok(
        afterFirst.characters.some(([characterId]) => characterId === ADVENT_CLEAR_REWARD_CHARACTER_ID),
        "first finish must grant clear_reward 100101's character 263009",
    )
    assert.deepEqual(
        rewardStateExceptCharacters(afterFirst),
        rewardStateExceptCharacters(beforeFirst),
        "first finish must change nothing besides the granted character",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID)?.finished,
        true,
        "first finish must mark the quest finished",
    )

    const secondFinish = await focusedFinish(viewerId, ADVENT_PURE_STORY_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY)
    assert.equal(secondFinish.statusCode, 200, `repeat finish must succeed: ${JSON.stringify(secondFinish.body)}`)
    assert.ok(secondFinish.data, "repeat finish response must include data")
    assert.deepEqual(
        secondFinish.data.story_join_character_id_list,
        [],
        "repeat finish must not insert story join characters again",
    )
    assert.deepEqual(
        secondFinish.data.item_list,
        {},
        "repeat finish must not add reward items again",
    )
    const afterSecond = captureRewardObservableState(playerId)
    assert.deepEqual(
        afterSecond,
        afterFirst,
        "second finish must add no reward, no duplicate character and no currency change",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID)?.finished,
        true,
        "progress must stay finished after the repeat finish",
    )
})

test("category 10 repeat finish of 100002001 is idempotent in observable reward state", async () => {
    const { playerId, viewerId } = await createPlayer(20)
    const beforeFirst = captureRewardObservableState(playerId)

    const firstFinish = await focusedFinish(viewerId, STORY_SINGLE_PURE_STORY_QUEST_ID, STORY_EVENT_SINGLE_CATEGORY)
    assert.equal(firstFinish.statusCode, 200, `first finish must succeed: ${JSON.stringify(firstFinish.body)}`)
    assert.ok(firstFinish.data, "first finish response must include data")
    const afterFirst = captureRewardObservableState(playerId)
    assert.equal(
        afterFirst.freeVmoney,
        beforeFirst.freeVmoney + STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY,
        "first finish must grant clear_reward 1's 15 beads as freeVmoney exactly once",
    )
    assert.deepEqual(
        afterFirst.characters,
        beforeFirst.characters,
        "first finish must not grant characters",
    )
    assert.deepEqual(
        afterFirst.equipment,
        beforeFirst.equipment,
        "first finish must not grant equipment",
    )
    assert.deepEqual(
        afterFirst.items,
        beforeFirst.items,
        "first finish must not grant items",
    )
    assert.equal(afterFirst.freeMana, beforeFirst.freeMana, "first finish must not change free mana")
    assert.equal(afterFirst.expPool, beforeFirst.expPool, "first finish must not change the exp pool")
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, STORY_EVENT_SINGLE_CATEGORY, STORY_SINGLE_PURE_STORY_QUEST_ID)?.finished,
        true,
        "first finish must mark the quest finished",
    )

    const secondFinish = await focusedFinish(viewerId, STORY_SINGLE_PURE_STORY_QUEST_ID, STORY_EVENT_SINGLE_CATEGORY)
    assert.equal(secondFinish.statusCode, 200, `repeat finish must succeed: ${JSON.stringify(secondFinish.body)}`)
    assert.ok(secondFinish.data, "repeat finish response must include data")
    assert.deepEqual(
        secondFinish.data.story_join_character_id_list,
        [],
        "repeat finish must not insert story join characters again",
    )
    assert.deepEqual(
        secondFinish.data.item_list,
        {},
        "repeat finish must not add reward items again",
    )
    const afterSecond = captureRewardObservableState(playerId)
    assert.deepEqual(
        afterSecond,
        afterFirst,
        "second finish must add no reward, no duplicate character and no currency change",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, STORY_EVENT_SINGLE_CATEGORY, STORY_SINGLE_PURE_STORY_QUEST_ID)?.finished,
        true,
        "progress must stay finished after the repeat finish",
    )
})

// Negative boundary cases: HTTP 400 must hold at baseline AND after the fix.
// Task 3 adds the per-reason message, the discriminated "[STORY]" log tag and
// the no-side-effect checks (no quest progress row, unchanged observable
// reward state) on top.

test("category 7 battle advent node 100002003 (sPlusRewardId) stays rejected with 400", async () => {
    const { playerId, viewerId } = await createPlayer(15)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_BATTLE_QUEST_ID),
        null,
        "no progress row may exist before the rejected call",
    )
    const { result, lines } = await captureStoryFinishLogs(() =>
        focusedFinish(viewerId, ADVENT_BATTLE_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY))
    assert.equal(
        result.statusCode,
        400,
        `battle advent node must stay rejected with 400, got: ${JSON.stringify(result)}`,
    )
    assert.equal(result.body.error, "Bad Request", "400 body must keep the Bad Request shape")
    assert.equal(
        result.body.message,
        BATTLE_QUEST_REJECTION_MESSAGE,
        "battle quest rejection must use the discriminated battle-quest message",
    )
    assert.ok(
        lines.some(line => line.startsWith("[STORY] battle quest rejected:")),
        `server log must record the battle quest rejection separately, got: ${JSON.stringify(lines)}`,
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_BATTLE_QUEST_ID),
        null,
        "rejected battle quest must not create quest progress",
    )
    assert.deepEqual(
        captureRewardObservableState(playerId),
        before,
        "rejected battle quest must not change observable reward state",
    )
})

test("category 10 battle story_event_single node 100002007 (sPlusRewardId) stays rejected with 400", async () => {
    const { playerId, viewerId } = await createPlayer(16)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, STORY_EVENT_SINGLE_CATEGORY, STORY_SINGLE_BATTLE_QUEST_ID),
        null,
        "no progress row may exist before the rejected call",
    )
    const { result, lines } = await captureStoryFinishLogs(() =>
        focusedFinish(viewerId, STORY_SINGLE_BATTLE_QUEST_ID, STORY_EVENT_SINGLE_CATEGORY))
    assert.equal(
        result.statusCode,
        400,
        `battle story_event_single node must stay rejected with 400, got: ${JSON.stringify(result)}`,
    )
    assert.equal(result.body.error, "Bad Request", "400 body must keep the Bad Request shape")
    assert.equal(
        result.body.message,
        BATTLE_QUEST_REJECTION_MESSAGE,
        "battle quest rejection must use the discriminated battle-quest message",
    )
    assert.ok(
        lines.some(line => line.startsWith("[STORY] battle quest rejected:")),
        `server log must record the battle quest rejection separately, got: ${JSON.stringify(lines)}`,
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, STORY_EVENT_SINGLE_CATEGORY, STORY_SINGLE_BATTLE_QUEST_ID),
        null,
        "rejected battle quest must not create quest progress",
    )
    assert.deepEqual(
        captureRewardObservableState(playerId),
        before,
        "rejected battle quest must not change observable reward state",
    )
})

test("unknown category 999 stays rejected with 400", async () => {
    const { playerId, viewerId } = await createPlayer(17)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, UNKNOWN_CATEGORY, ADVENT_PURE_STORY_QUEST_ID),
        null,
        "no progress row may exist before the rejected call",
    )
    const { result, lines } = await captureStoryFinishLogs(() =>
        focusedFinish(viewerId, ADVENT_PURE_STORY_QUEST_ID, UNKNOWN_CATEGORY))
    assert.equal(
        result.statusCode,
        400,
        `unknown category must stay rejected with 400, got: ${JSON.stringify(result)}`,
    )
    assert.equal(result.body.error, "Bad Request", "400 body must keep the Bad Request shape")
    assert.equal(
        result.body.message,
        UNSUPPORTED_CATEGORY_MESSAGE,
        "unknown category rejection must use the discriminated unsupported-category message",
    )
    assert.ok(
        lines.some(line => line.startsWith("[STORY] category is not supported by story finish:")),
        `server log must record the unsupported category separately, got: ${JSON.stringify(lines)}`,
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, UNKNOWN_CATEGORY, ADVENT_PURE_STORY_QUEST_ID),
        null,
        "rejected unknown category must not create quest progress",
    )
    assert.deepEqual(
        captureRewardObservableState(playerId),
        before,
        "rejected unknown category must not change observable reward state",
    )
})

test("category 7 nonexistent quest 199999999 stays rejected with 400", async () => {
    const { playerId, viewerId } = await createPlayer(18)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, NONEXISTENT_STORY_QUEST_ID),
        null,
        "no progress row may exist before the rejected call",
    )
    const { result, lines } = await captureStoryFinishLogs(() =>
        focusedFinish(viewerId, NONEXISTENT_STORY_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY))
    assert.equal(
        result.statusCode,
        400,
        `nonexistent quest must stay rejected with 400, got: ${JSON.stringify(result)}`,
    )
    assert.equal(result.body.error, "Bad Request", "400 body must keep the Bad Request shape")
    assert.equal(
        result.body.message,
        QUEST_NOT_FOUND_MESSAGE,
        "nonexistent quest rejection must use the discriminated quest-not-found message",
    )
    assert.ok(
        lines.some(line => line.startsWith("[STORY] quest not found:")),
        `server log must record the quest lookup failure separately, got: ${JSON.stringify(lines)}`,
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, NONEXISTENT_STORY_QUEST_ID),
        null,
        "rejected nonexistent quest must not create quest progress",
    )
    assert.deepEqual(
        captureRewardObservableState(playerId),
        before,
        "rejected nonexistent quest must not change observable reward state",
    )
})

// ---------------------------------------------------------------------------
// World story event coverage (category 18 / WORLD_STORY_EVENT)
//
// The client resolves world story single quests (SingleQuestIdKind index 9) to
// category 18 and sends their pure story nodes through story_quest/finish
// (StoryQuestFinishLoadingTask handles them and its response path contains
// WorldStoryEventSequelDetector.stockFirstClearedQuestToBeContinued for kind
// index 9). 472 of the 913 bundled world_story_event rows have no battle
// fields at all; they hit the same whitelist gap category 7/10 did.
// ---------------------------------------------------------------------------

test("[RED] category 18 pure story node 100100001 finishes via story_quest/finish", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended to "
        + "WORLD_STORY_EVENT(18). Baseline answers HTTP 400 "
        + "('[STORY] category is not supported by story finish: category=18'). "
        + "The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(21)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, WORLD_STORY_EVENT_CATEGORY, WORLD_STORY_PURE_STORY_QUEST_ID),
        null,
        "fresh player must have no progress row for the world story node",
    )
    const result = await focusedFinish(viewerId, WORLD_STORY_PURE_STORY_QUEST_ID, WORLD_STORY_EVENT_CATEGORY)
    assert.equal(
        result.statusCode,
        200,
        `pure story world_story_event node must finish with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish success response must include data")
    assert.deepEqual(
        result.data.story_join_character_id_list,
        [],
        "world story node 100100001 must not grant story join characters",
    )
    const progress = getPlayerSingleQuestProgressSync(
        playerId,
        WORLD_STORY_EVENT_CATEGORY,
        WORLD_STORY_PURE_STORY_QUEST_ID,
    )
    assert.ok(progress, "story finish must create a progress row for world_story_event 100100001")
    assert.equal(progress.finished, true, "story finish must mark quest 100100001 finished for category 18")
    // Observable reward delta (grounded by the clear_reward 1 guardrail): the
    // same beads row category 10's node uses, so first clear grants freeVmoney.
    const after = captureRewardObservableState(playerId)
    assert.equal(
        after.freeVmoney,
        before.freeVmoney + STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY,
        "first clear must grant clear_reward 1's 15 beads as freeVmoney",
    )
    assert.deepEqual(after.characters, before.characters, "world story clear reward must not grant characters")
    assert.deepEqual(after.equipment, before.equipment, "world story clear reward must not grant equipment")
    assert.deepEqual(after.items, before.items, "world story clear reward must not grant items")
    assert.equal(after.freeMana, before.freeMana, "world story clear reward must not change free mana")
    assert.equal(after.expPool, before.expPool, "world story clear reward must not change the exp pool")
    assert.equal(
        result.data.user_info.free_vmoney,
        after.freeVmoney,
        "response user_info must reflect the granted freeVmoney",
    )
})

test("[RED] category 18 pure story node 100100001 finishes via story_quest/finish_with_skip", async t => {
    t.diagnostic(
        "RED evidence: expected to FAIL until the story finish category whitelist is extended; "
        + "baseline answers HTTP 400 ('[STORY] category is not supported by story finish: category=18'). "
        + "The assertion below targets the desired end state (HTTP 200) and must not be flipped.",
    )
    const { playerId, viewerId } = await createPlayer(22)
    const result = await focusedFinish(
        viewerId,
        WORLD_STORY_PURE_STORY_QUEST_ID,
        WORLD_STORY_EVENT_CATEGORY,
        "finish_with_skip",
    )
    assert.equal(
        result.statusCode,
        200,
        `pure story world_story_event node must finish_with_skip with 200, got: ${JSON.stringify(result)}`,
    )
    assert.ok(result.data, "story finish_with_skip success response must include data")
    const progress = getPlayerSingleQuestProgressSync(
        playerId,
        WORLD_STORY_EVENT_CATEGORY,
        WORLD_STORY_PURE_STORY_QUEST_ID,
    )
    assert.ok(progress, "finish_with_skip must create a progress row for world_story_event 100100001")
    assert.equal(progress.finished, true, "finish_with_skip must mark quest 100100001 finished for category 18")
})

// After the whitelist extension the category-18 battle node reaches the
// sPlusReward guard instead of the category gate, so the rejection carries the
// discriminated battle-quest message and "[STORY]" log tag.
test("category 18 battle world_story_event node 100100003 (sPlusRewardId) stays rejected with 400", async () => {
    const { playerId, viewerId } = await createPlayer(23)
    const before = captureRewardObservableState(playerId)
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, WORLD_STORY_EVENT_CATEGORY, WORLD_STORY_BATTLE_QUEST_ID),
        null,
        "no progress row may exist before the rejected call",
    )
    const { result, lines } = await captureStoryFinishLogs(() =>
        focusedFinish(viewerId, WORLD_STORY_BATTLE_QUEST_ID, WORLD_STORY_EVENT_CATEGORY))
    assert.equal(
        result.statusCode,
        400,
        `battle world_story_event node must stay rejected with 400, got: ${JSON.stringify(result)}`,
    )
    assert.equal(result.body.error, "Bad Request", "400 body must keep the Bad Request shape")
    assert.equal(
        result.body.message,
        BATTLE_QUEST_REJECTION_MESSAGE,
        "battle quest rejection must use the discriminated battle-quest message",
    )
    assert.ok(
        lines.some(line => line.startsWith("[STORY] battle quest rejected:")),
        `server log must record the battle quest rejection separately, got: ${JSON.stringify(lines)}`,
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, WORLD_STORY_EVENT_CATEGORY, WORLD_STORY_BATTLE_QUEST_ID),
        null,
        "rejected battle quest must not create quest progress",
    )
    assert.deepEqual(
        captureRewardObservableState(playerId),
        before,
        "rejected battle quest must not change observable reward state",
    )
})

// Final-review follow-up: quest id 100002001 exists in BOTH the category 7 and
// the category 10 tables with different rewards. The suite used to finish the
// two on different players, so a refactor of the (player_id, section, quest_id)
// progress key — e.g. dropping section — would not have been caught. One player
// finishing both categories must keep two independent progress rows and grant
// each first-clear reward exactly once.
test("same player finishing quest 100002001 of category 7 and 10 keeps independent progress and rewards", async () => {
    const { playerId, viewerId } = await createPlayer(24)
    const before = captureRewardObservableState(playerId)

    const adventFinish = await focusedFinish(viewerId, ADVENT_PURE_STORY_QUEST_ID, ADVENT_EVENT_SINGLE_CATEGORY)
    assert.equal(adventFinish.statusCode, 200, `advent finish must succeed: ${JSON.stringify(adventFinish.body)}`)

    const storySingleFinish = await focusedFinish(viewerId, STORY_SINGLE_PURE_STORY_QUEST_ID, STORY_EVENT_SINGLE_CATEGORY)
    assert.equal(
        storySingleFinish.statusCode,
        200,
        `story_event_single finish must succeed: ${JSON.stringify(storySingleFinish.body)}`,
    )

    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, ADVENT_EVENT_SINGLE_CATEGORY, ADVENT_PURE_STORY_QUEST_ID)?.finished,
        true,
        "category 7 progress row for 100002001 must exist and be finished",
    )
    assert.equal(
        getPlayerSingleQuestProgressSync(playerId, STORY_EVENT_SINGLE_CATEGORY, STORY_SINGLE_PURE_STORY_QUEST_ID)?.finished,
        true,
        "category 10 progress row for 100002001 must exist and be finished",
    )

    const after = captureRewardObservableState(playerId)
    assert.equal(
        after.freeVmoney,
        before.freeVmoney + STORY_SINGLE_CLEAR_REWARD_FREE_VMONEY,
        "the category 10 beads grant must land exactly once across the two finishes",
    )
    assert.equal(
        after.characters.length,
        before.characters.length + 1,
        "the category 7 clear-reward character must be granted exactly once across the two finishes",
    )
    assert.ok(
        after.characters.some(([characterId]) => characterId === ADVENT_CLEAR_REWARD_CHARACTER_ID),
        "the granted character must be clear_reward 100101's character 263009",
    )
})
