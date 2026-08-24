"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    ACTIVE_MANA_REWARD,
    ACTIVE_MISSION_ID,
    AWAKE_CHARACTER_ID,
    AWAKE_MANA_THRESHOLD,
    CHARACTER_QUEST_IDS,
    closeAwakeOwnerFactPublicationFixture,
    createAwakeOwnerFactPublicationFixture,
    runAwakeOwnerFactPublicationCleanup,
} = require("./helpers/awake-owner-fact-publication-fixture.cjs")
const {
    getAwakeFactKeysFromLegacyRewardResults,
} = require("../src/lib/mission/awake-reward-facts")

const PASS_CARD_EVENT_ID = 3
const PASS_CARD_REWARD_ID = 124
const PASS_CARD_MANA_REWARD = 20_000
const RAID_EVENT_ID = 4
const RAID_MANA_REWARD = 500

function loadMailAwakeFactKeyHelper() {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/mail.ts"),
        "utf8",
    )
    const start = source.indexOf("function getMailAwakeInvalidatedFactKeys")
    const end = source.indexOf("\n\nfunction unsupportedMailReply", start)
    assert.ok(start >= 0 && end > start, "mail Awake helper must remain a local pure function")
    const implementation = source
        .slice(start, end)
        .replace("mails: readonly RawPlayerMail[]", "mails")
        .replaceAll(" as const", "")
    const { MailType } = require("../src/data/domains/mail")
    return Function("MailType", `${implementation}; return getMailAwakeInvalidatedFactKeys`)(MailType)
}

let fixture

function assertAwakePublished(playerId, characterList) {
    assert.deepEqual(fixture.awakeUnlock(playerId), { 1: 1 })
    assert.deepEqual(
        fixture.awakeCharacter(characterList)?.mana_board_awake,
        { 1: 1 },
    )
}

function awakeUnlockCount(playerId) {
    return fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = ? AND board_index = 1
    `).get(playerId, AWAKE_CHARACTER_ID).count
}

function rejectAwakePublication(playerId, triggerName) {
    fixture.database.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON players_character_awake_unlocks
        WHEN NEW.player_id = ${playerId} AND NEW.character_id = ${AWAKE_CHARACTER_ID}
        BEGIN SELECT RAISE(ABORT, 'injected ${triggerName} failure'); END;
    `)
}

async function withCapturedPublicationErrors(operation) {
    const errors = []
    const originalConsoleError = console.error
    console.error = (...args) => errors.push(args)
    try {
        return { result: await operation(), errors }
    } finally {
        console.error = originalConsoleError
    }
}

test.before(async () => {
    fixture = await createAwakeOwnerFactPublicationFixture()
})

test.after(async () => {
    await closeAwakeOwnerFactPublicationFixture(fixture)
})

test("fixture cleanup continues after failure and retains the original setup error", async () => {
    assert.equal(typeof runAwakeOwnerFactPublicationCleanup, "function")
    const setupError = new Error("injected fixture setup failure")
    const cleanupError = new Error("injected fixture cleanup failure")
    const cleanupSteps = []

    await assert.rejects(
        runAwakeOwnerFactPublicationCleanup([
            () => {
                cleanupSteps.push("failing cleanup")
                throw cleanupError
            },
            () => cleanupSteps.push("later cleanup"),
        ], { primaryError: setupError }),
        error => {
            assert.ok(error instanceof AggregateError)
            assert.equal(error.errors.length, 2)
            assert.strictEqual(error.errors[0], setupError)
            assert.strictEqual(error.errors[1], cleanupError)
            return true
        },
    )
    assert.deepEqual(cleanupSteps, ["failing cleanup", "later cleanup"])
})

test("legacy reward fallback maps positive, zero, non-Mana, and mixed results exactly", () => {
    assert.deepEqual(
        getAwakeFactKeysFromLegacyRewardResults({ user_info: { free_mana: 5 } }),
        [{ kind: "player" }],
    )
    assert.deepEqual(
        getAwakeFactKeysFromLegacyRewardResults(
            { user_info: { free_mana: 0 } },
            { user_info: { free_mana: undefined } },
            null,
        ),
        [],
    )
    assert.deepEqual(
        getAwakeFactKeysFromLegacyRewardResults({ user_info: { free_vmoney: 5 } }),
        [],
    )
    for (const value of [0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.deepEqual(
            getAwakeFactKeysFromLegacyRewardResults({ user_info: { free_mana: value } }),
            [],
            `non-safe Mana value ${String(value)} must not invalidate player facts`,
        )
    }
    assert.deepEqual(
        getAwakeFactKeysFromLegacyRewardResults(
            { user_info: { free_mana: 0 } },
            { user_info: { free_vmoney: 9 } },
            { user_info: { free_mana: 2 } },
        ),
        [{ kind: "player" }],
    )
})

test("mail Awake helper maps FREE_MANA, zero, non-Mana, and mixed mail exactly", () => {
    const getMailAwakeInvalidatedFactKeys = loadMailAwakeFactKeyHelper()
    const { MailType } = require("../src/data/domains/mail")
    const mail = type => ({ type })

    assert.deepEqual(
        getMailAwakeInvalidatedFactKeys([mail(MailType.FREE_MANA)]),
        [{ kind: "player" }],
    )
    assert.deepEqual(getMailAwakeInvalidatedFactKeys([]), [])
    assert.deepEqual(getMailAwakeInvalidatedFactKeys([mail(0), mail(MailType.ITEM)]), [])
    assert.deepEqual(
        getMailAwakeInvalidatedFactKeys([mail(MailType.ITEM), mail(MailType.FREE_MANA)]),
        [{ kind: "player" }],
    )
})

test("story finish publishes direct and parent Awake progress when section 3 crosses its threshold", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("story")
    fixture.prepareForStoryUnlock(playerId)

    const { response, body } = await fixture.post("/story", "finish", {
        category: 3,
        quest_id: CHARACTER_QUEST_IDS[2],
        party_id: 1,
        viewer_id: viewerId,
        api_count: 1,
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(
        fixture.questDomain.getPlayerSingleQuestProgressSync(
            playerId,
            3,
            CHARACTER_QUEST_IDS[2],
        )?.finished,
        true,
    )
    assertAwakePublished(playerId, body.data.character_list)

    const evaluated = fixture.createAwakeRequestContext({
        playerId,
        candidateCharacterIds: [],
        invalidatedFactKeys: [{ kind: "questProgress", sections: [3] }],
    }).evaluate()
    assert.deepEqual(
        new Map(evaluated.map(entry => [entry.missionId, entry.progress])),
        new Map([
            [2630021, 3],
            [2630022, AWAKE_MANA_THRESHOLD],
            [2630023, 1],
            [2630024, 3],
        ]),
    )
})

test("active mission uses MissionRewardGranter invalidations to publish a Mana Awake unlock", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("active-mission")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - ACTIVE_MANA_REWARD)
    fixture.missionDomain.updatePlayerActiveMissionSync(playerId, ACTIVE_MISSION_ID, 1)
    fixture.missionDomain.updatePlayerActiveMissionStageSync(
        playerId,
        1,
        ACTIVE_MISSION_ID,
        false,
    )

    const { response, body } = await fixture.post("/active", "receive", {
        viewer_id: viewerId,
        api_count: 1,
        active_mission_list: [{ mission_id: ACTIVE_MISSION_ID, stages: [1] }],
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.equal(
        fixture.missionDomain.getPlayerActiveMissionsSync(playerId)[ACTIVE_MISSION_ID]
            .stages[1],
        true,
    )
    assertAwakePublished(playerId, body.data.character_list)
})

test("single finish publishes player invalidation after its final authoritative write", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("single")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - 1)
    const playId = "awake-owner-single"
    fixture.insertActiveQuest(playerId, {
        questId: fixture.MAIN_QUEST_ID,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: null,
        playId,
        continueCount: 0,
    })

    const { response, body } = await fixture.post(
        "/single",
        "finish",
        fixture.singleFinishPayload(viewerId, playId, 1),
    )

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained >= AWAKE_MANA_THRESHOLD, true)
    assert.equal(fixture.activeQuests[playerId], undefined)
    assertAwakePublished(playerId, body.data.character_list)
})

test("multi orchestration publishes player invalidation in a runnable settlement without dual servers", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("multi")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - 1)

    const result = fixture.runMultiSettlement(playerId, viewerId, "awake-owner-multi", 1)

    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained >= AWAKE_MANA_THRESHOLD, true)
    assert.equal(fixture.activeQuests[playerId], undefined)
    assertAwakePublished(playerId, result.characterList)
})

test("pass-card receive_all publishes a Mana Awake unlock after committing its reward record", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("pass-card")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - PASS_CARD_MANA_REWARD)
    fixture.passCardDomain.addPlayerPassCardPointSync(playerId, PASS_CARD_EVENT_ID, 400)

    const payload = {
        viewer_id: viewerId,
        pass_card_id: PASS_CARD_EVENT_ID,
        all_receive: [],
        reward1_receive: [PASS_CARD_REWARD_ID],
        reward2_receive: [],
    }
    const first = await fixture.post("/pass-card", "receive_all", payload)

    assert.equal(first.response.statusCode, 200, first.response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.deepEqual(
        fixture.passCardDomain.getPlayerPassCardRewardRecordsSync(playerId, PASS_CARD_EVENT_ID),
        [{ rewardId: PASS_CARD_REWARD_ID, isReceived1: 1, isReceived2: 0 }],
    )
    assertAwakePublished(playerId, first.body.data.character_list)

    const repeated = await fixture.post("/pass-card", "receive_all", payload)
    assert.equal(repeated.response.statusCode, 200, repeated.response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.deepEqual(repeated.body.data.character_list, [])
    assert.equal(awakeUnlockCount(playerId), 1)
})

test("pass-card publication failure preserves the committed reward and original response", async t => {
    const { playerId, viewerId } = await fixture.createPlayer("pass-card-publication-failure")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - PASS_CARD_MANA_REWARD)
    fixture.passCardDomain.addPlayerPassCardPointSync(playerId, PASS_CARD_EVENT_ID, 400)
    const triggerName = "reject_pass_card_awake_publication"
    rejectAwakePublication(playerId, triggerName)
    t.after(() => fixture.database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    const { result, errors } = await withCapturedPublicationErrors(() => fixture.post(
        "/pass-card",
        "receive_all",
        {
            viewer_id: viewerId,
            pass_card_id: PASS_CARD_EVENT_ID,
            all_receive: [],
            reward1_receive: [PASS_CARD_REWARD_ID],
            reward2_receive: [],
        },
    ))

    assert.equal(result.response.statusCode, 200, result.response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.deepEqual(
        fixture.passCardDomain.getPlayerPassCardRewardRecordsSync(playerId, PASS_CARD_EVENT_ID),
        [{ rewardId: PASS_CARD_REWARD_ID, isReceived1: 1, isReceived2: 0 }],
    )
    assert.deepEqual(result.body.data.character_list, [])
    assert.equal(result.body.data.user_info.free_mana, fixture.playerDomain.getPlayerSync(playerId).freeMana)
    assert.equal(fixture.awakeUnlock(playerId), undefined)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][0]), /Failed to publish character unlocks/)
    const publicationError = errors[0][1]
    assert.ok(publicationError instanceof Error)
    assert.match(publicationError.message, new RegExp(triggerName))
    assert.equal(publicationError.code, "SQLITE_CONSTRAINT_TRIGGER")
})

test("raid summary publishes a Mana Awake unlock after committing its reward cursor", async () => {
    const { playerId, viewerId } = await fixture.createPlayer("raid-summary")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - RAID_MANA_REWARD)
    fixture.raidEventDomain.upsertRaidEventBossStateSync(RAID_EVENT_ID, {
        weightedKillCount: 0,
        totalKillCount: 1,
    })

    const payload = { viewer_id: viewerId, event_id: RAID_EVENT_ID, api_count: 1 }
    const first = await fixture.post("/raid", "summary", payload)

    assert.equal(first.response.statusCode, 200, first.response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.equal(fixture.raidEventDomain.getPlayerRaidEventSync(playerId, RAID_EVENT_ID).receivedUpTo, 1)
    assert.equal(fixture.itemDomain.getPlayerItemSync(playerId, 100000), 25)
    assertAwakePublished(playerId, first.body.data.character_list)

    const repeated = await fixture.post("/raid", "summary", { ...payload, api_count: 2 })
    assert.equal(repeated.response.statusCode, 200, repeated.response.body)
    assert.deepEqual(repeated.body.data.kill_count_reward_data.reward_list, [])
    assert.equal("character_list" in repeated.body.data, false)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.equal(fixture.itemDomain.getPlayerItemSync(playerId, 100000), 25)
    assert.equal(awakeUnlockCount(playerId), 1)
})

test("raid summary publication failure preserves the committed cursor and original reward response", async t => {
    const { playerId, viewerId } = await fixture.createPlayer("raid-summary-publication-failure")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD - RAID_MANA_REWARD)
    fixture.raidEventDomain.upsertRaidEventBossStateSync(RAID_EVENT_ID, {
        weightedKillCount: 0,
        totalKillCount: 1,
    })
    const triggerName = "reject_raid_summary_awake_publication"
    rejectAwakePublication(playerId, triggerName)
    t.after(() => fixture.database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`))

    const { result, errors } = await withCapturedPublicationErrors(() => fixture.post(
        "/raid",
        "summary",
        { viewer_id: viewerId, event_id: RAID_EVENT_ID, api_count: 1 },
    ))

    assert.equal(result.response.statusCode, 200, result.response.body)
    assert.equal(fixture.playerDomain.getPlayerSync(playerId).totalManaObtained, AWAKE_MANA_THRESHOLD)
    assert.equal(fixture.raidEventDomain.getPlayerRaidEventSync(playerId, RAID_EVENT_ID).receivedUpTo, 1)
    assert.equal(fixture.itemDomain.getPlayerItemSync(playerId, 100000), 25)
    assert.equal(
        result.body.data.user_info.free_mana,
        fixture.playerDomain.getPlayerSync(playerId).freeMana,
    )
    assert.deepEqual(result.body.data.item_list, { 100000: 25 })
    assert.deepEqual(result.body.data.character_list, [])
    assert.equal(fixture.awakeUnlock(playerId), undefined)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][0]), /Failed to publish character unlocks/)
    const publicationError = errors[0][1]
    assert.ok(publicationError instanceof Error)
    assert.match(publicationError.message, new RegExp(triggerName))
    assert.equal(publicationError.code, "SQLITE_CONSTRAINT_TRIGGER")
})

test("all existing global-fact owners pass bounded invalidations into fresh publication", () => {
    const source = relativePath => fs.readFileSync(
        path.join(__dirname, "..", relativePath),
        "utf8",
    )
    const single = source("src/lib/quest/finish/single-settlement-writes.ts")
    const singlePublication = source("src/lib/quest/finish/single-mission-publication.ts")
    const multi = source("src/multi/settlement/orchestrator.ts")

    assert.match(source("src/routes/api/storyQuest.ts"), /invalidatedFactKeys:[\s\S]*questProgress/)
    assert.match(source("src/routes/api/activeMission.ts"), /invalidatedFactKeys:\s*granter\.invalidatedFactKeys/)
    assert.match(source("src/routes/api/passCard.ts"), /invalidatedFactKeys:\s*result\.invalidatedFactKeys/)
    assert.match(source("src/routes/api/raidEvent.ts"), /invalidatedFactKeys:[\s\S]*rewardResult/)
    assert.match(source("src/routes/api/boxGacha.ts"), /invalidatedFactKeys:[\s\S]*rewardResult/)
    assert.equal((source("src/routes/api/shop.ts").match(/invalidatedFactKeys:/g) ?? []).length, 2)
    assert.equal((source("src/routes/api/mail.ts").match(/invalidatedFactKeys:/g) ?? []).length, 2)
    assert.match(single, /invalidatedFactKeys/)
    assert.match(singlePublication, /input\.questCategory\s*===\s*QuestCategory\.CHARACTER/)
    assert.match(multi, /invalidatedFactKeys/)
    assert.match(multi, /questCategory\s*===\s*QuestCategory\.CHARACTER/)
})
