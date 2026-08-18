"use strict"

const officialMissions = require("../../../assets/mission_active.json")
const officialEvents = require("../../../assets/mission_active_event.json")
const officialRewards = require("../../../assets/mission_active_reward.json")
const singleFixture = require("../single_battle_settlement_fixture.cjs")

const FINISH_MISSION_ID = 99301
const FINISH_EVENT_ID = 993
const STORY_QUEST_ID = 101
const STORY_CATEGORY = 3
const SINGLE_ROLLBACK_MARKER = "ACTIVE_MISSION_SINGLE_STAGE_ROLLBACK_34_2"
const STORY_ROLLBACK_MARKER = "ACTIVE_MISSION_STORY_STAGE_ROLLBACK_34_2"

function missionRow() {
    const row = []
    row[0] = String(FINISH_EVENT_ID)
    row[1] = "1"
    row[3] = "active_mission_focused_single_finish"
    row[29] = "14"
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    return row
}

function eventRow() {
    const row = []
    row[0] = "active_mission_focused_single_finish_event"
    row[2] = "0"
    row[3] = "1"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "(None)"
    row[22] = "(None)"
    return row
}

function rewardRow() {
    const row = []
    row[3] = "1"
    row[4] = "(None)"
    row[7] = "0"
    row[8] = "1"
    return row
}

function singleTableOverrides() {
    if (officialMissions[FINISH_MISSION_ID] || officialEvents[FINISH_EVENT_ID]) {
        throw new Error("focused finish fixture collides with official Active Mission content")
    }
    return {
        "mission_active.json": {
            ...officialMissions,
            [FINISH_MISSION_ID]: [missionRow()],
        },
        "mission_active_event.json": {
            ...officialEvents,
            [FINISH_EVENT_ID]: [eventRow()],
        },
        "mission_active_reward.json": {
            ...officialRewards,
            [FINISH_MISSION_ID]: { 1: [rewardRow()] },
        },
        "score_reward.json": singleFixture.DETERMINISTIC_SCORE_REWARDS,
        "additional_reward_rules.json": singleFixture.DETERMINISTIC_ADDITIONAL_REWARDS,
    }
}

function primeActiveMissions(playerId) {
    const { getContentSnapshot } = require("../../../src/content/runtime/content-snapshot")
    const { reconcileActiveMissionFacts } = require("../../../src/lib/mission")
    reconcileActiveMissionFacts({
        playerId,
        repository: getContentSnapshot().repository,
        now: Date.parse("2024-08-14T12:00:00.000Z"),
    })
}

async function createSingleApp(createApp) {
    const route = require("../../../src/routes/api/singleBattleQuest").default
    return createApp(route, { prefix: "/api/index.php/single_battle_quest" })
}

async function createStoryApp(createApp) {
    const route = require("../../../src/routes/api/storyQuest").default
    return createApp(route, { prefix: "/api/index.php/story_quest" })
}

function setupSingleQuest(playerId, playId) {
    const { insertActiveQuest } = require("../../../src/lib/quest/active-quest-service")
    insertActiveQuest(playerId, singleFixture.createActiveQuest({ playId }))
}

function postSingle(runtime, app, playId, accomplished) {
    const payload = singleFixture.finishPayload({
        addMana: 0,
        characterId: 1,
        playId,
    })
    payload.is_accomplished = accomplished
    return app.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/finish",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: runtime.encodeRequest(payload),
    })
}

function postStory(app, player) {
    return app.inject({
        method: "POST",
        url: "/api/index.php/story_quest/finish",
        payload: {
            category: STORY_CATEGORY,
            quest_id: STORY_QUEST_ID,
            party_id: 1,
            viewer_id: player.viewerId,
            api_count: 1,
        },
    })
}

async function runSingleFinishScenario(runtime, name) {
    const accomplished = name === "single-finish-active"
    const playId = `focused-${name}`
    return runtime.runIsolated({
        name,
        tableOverrides: singleTableOverrides(),
        setup: ({ createPlayer }) => {
            const player = createPlayer(name, singleFixture.VIEWER_ID)
            primeActiveMissions(player.playerId)
            setupSingleQuest(player.playerId, playId)
            return player
        },
        execute: async ({ db, player, createApp }) => {
            const app = await createSingleApp(createApp)
            const response = await postSingle(runtime, app, playId, accomplished)
            return runtime.behaviorSummary({ response, db, playerId: player.playerId })
        },
    })
}

async function runSingleFinishRollback(runtime) {
    const playId = "focused-rollback-single"
    return runtime.runIsolated({
        name: "rollback-single-finish",
        tableOverrides: singleTableOverrides(),
        setup: ({ db, createPlayer }) => {
            const player = createPlayer("rollback-single-finish", singleFixture.VIEWER_ID)
            primeActiveMissions(player.playerId)
            setupSingleQuest(player.playerId, playId)
            db.exec(`
                CREATE TRIGGER fail_single_active_stage_insert
                BEFORE INSERT ON players_active_missions_stages
                WHEN NEW.player_id = ${player.playerId} AND NEW.mission_id = ${FINISH_MISSION_ID}
                BEGIN
                    SELECT RAISE(ABORT, '${SINGLE_ROLLBACK_MARKER}');
                END
            `)
            return player
        },
        execute: async ({ player, createApp, snapshotOwner }) => {
            const { activeQuests } = require("../../../src/lib/quest/active-quest-service")
            const app = await createSingleApp(createApp)
            const before = {
                database: snapshotOwner(),
                memory: structuredClone(activeQuests[player.playerId]),
            }
            const response = await postSingle(runtime, app, playId, true)
            const after = {
                database: snapshotOwner(),
                memory: structuredClone(activeQuests[player.playerId]),
            }
            return runtime.isInjectedRollback({
                response,
                marker: SINGLE_ROLLBACK_MARKER,
                before,
                after,
            })
        },
    })
}

async function runStoryFinishScenario(runtime, name) {
    const repeat = name === "story-finish-repeat"
    return runtime.runIsolated({
        name,
        setup: async ({ createPlayer, createApp }) => {
            const player = createPlayer(name, repeat ? 800000711 : 800000710)
            primeActiveMissions(player.playerId)
            if (!repeat) return player
            const app = await createStoryApp(createApp)
            const first = await postStory(app, player)
            if (first.statusCode !== 200) {
                throw new Error(`story repeat warmup failed: ${first.statusCode} ${first.body}`)
            }
            return { ...player, app }
        },
        execute: async ({ db, player, createApp }) => {
            const app = player.app ?? await createStoryApp(createApp)
            const response = await postStory(app, player)
            return runtime.behaviorSummary({ response, db, playerId: player.playerId })
        },
    })
}

async function runStoryFinishRollback(runtime) {
    return runtime.runIsolated({
        name: "rollback-story-finish",
        setup: ({ db, createPlayer }) => {
            const player = createPlayer("rollback-story-finish", 800000712)
            primeActiveMissions(player.playerId)
            db.exec(`
                CREATE TRIGGER fail_story_active_stage_insert
                BEFORE INSERT ON players_active_missions_stages
                WHEN NEW.player_id = ${player.playerId} AND NEW.mission_id = 11010
                BEGIN
                    SELECT RAISE(ABORT, '${STORY_ROLLBACK_MARKER}');
                END
            `)
            return player
        },
        execute: async ({ player, createApp, snapshotOwner }) => {
            const app = await createStoryApp(createApp)
            const before = snapshotOwner()
            const response = await postStory(app, player)
            const after = snapshotOwner()
            return runtime.isInjectedRollback({
                response,
                marker: STORY_ROLLBACK_MARKER,
                before,
                after,
            })
        },
    })
}

module.exports = {
    runSingleFinishRollback,
    runSingleFinishScenario,
    runStoryFinishRollback,
    runStoryFinishScenario,
}
