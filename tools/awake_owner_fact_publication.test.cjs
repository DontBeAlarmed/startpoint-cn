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
} = require("./helpers/awake-owner-fact-publication-fixture.cjs")
const {
    getAwakeFactKeysFromLegacyRewardResults,
} = require("../src/lib/mission/awake-reward-facts")

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

test.before(async () => {
    fixture = await createAwakeOwnerFactPublicationFixture()
})

test.after(async () => {
    await closeAwakeOwnerFactPublicationFixture(fixture)
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

test("all existing global-fact owners pass bounded invalidations into fresh publication", () => {
    const source = relativePath => fs.readFileSync(
        path.join(__dirname, "..", relativePath),
        "utf8",
    )
    const single = source("src/lib/quest/finish/single-settlement-writes.ts")
    const multi = source("src/multi/settlement/orchestrator.ts")

    assert.match(source("src/routes/api/storyQuest.ts"), /invalidatedFactKeys:[\s\S]*questProgress/)
    assert.match(source("src/routes/api/activeMission.ts"), /invalidatedFactKeys:\s*granter\.invalidatedFactKeys/)
    assert.match(source("src/routes/api/boxGacha.ts"), /invalidatedFactKeys:[\s\S]*rewardResult/)
    assert.equal((source("src/routes/api/shop.ts").match(/invalidatedFactKeys:/g) ?? []).length, 2)
    assert.equal((source("src/routes/api/mail.ts").match(/invalidatedFactKeys:/g) ?? []).length, 2)
    assert.match(single, /invalidatedFactKeys/)
    assert.match(single, /questCategory\s*===\s*QuestCategory\.CHARACTER/)
    assert.match(multi, /invalidatedFactKeys/)
    assert.match(multi, /questCategory\s*===\s*QuestCategory\.CHARACTER/)
})
