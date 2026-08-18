"use strict"

const officialMissions = require("../../../assets/mission_active.json")
const officialEvents = require("../../../assets/mission_active_event.json")
const officialRewards = require("../../../assets/mission_active_reward.json")

const LOAD_MISSION_ID = 99101
const LOAD_EVENT_ID = 991
const LOAD_ROLLBACK_MARKER = "ACTIVE_MISSION_LOAD_STAGE_ROLLBACK_34_2"

function missionRow() {
    const row = []
    row[0] = String(LOAD_EVENT_ID)
    row[1] = "1"
    row[3] = "active_mission_focused_load"
    row[29] = "0"
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    return row
}

function eventRow() {
    const row = []
    row[0] = "active_mission_focused_load_event"
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

function tableOverrides() {
    if (officialMissions[LOAD_MISSION_ID] || officialEvents[LOAD_EVENT_ID]) {
        throw new Error("focused load fixture collides with official Active Mission content")
    }
    return {
        "mission_active.json": {
            ...officialMissions,
            [LOAD_MISSION_ID]: [missionRow()],
        },
        "mission_active_event.json": {
            ...officialEvents,
            [LOAD_EVENT_ID]: [eventRow()],
        },
        "mission_active_reward.json": {
            ...officialRewards,
            [LOAD_MISSION_ID]: { 1: [rewardRow()] },
        },
    }
}

async function createLoadApp(createApp) {
    const route = require("../../../src/routes/cn/load").default
    return createApp(route, {
        prefix: "/",
        assetProvider: { mode: "client-owned" },
    })
}

function postLoad(app, player) {
    return app.inject({
        method: "POST",
        url: "/load",
        payload: {
            viewer_id: player.viewerId,
            device_id: 1,
            device_token: "focused",
            keychain: player.viewerId,
            graphics_device_name: "focused",
            platform_os_version: "focused",
            storage_directory_path: "focused",
        },
    })
}

function activeMissionDelta(before, after) {
    const beforeMissions = new Map(before.missions.map(mission => [mission.id, mission]))
    const beforeStages = new Set(before.stages.map(stage => `${stage.missionId}:${stage.stage}`))
    const afterStages = new Map()
    for (const stage of after.stages) {
        const stages = afterStages.get(stage.missionId) ?? []
        if (!beforeStages.has(`${stage.missionId}:${stage.stage}`)) {
            stages.push({ stage: stage.stage, received: stage.status === 1 })
        }
        afterStages.set(stage.missionId, stages)
    }
    return after.missions.filter(mission => (
        beforeMissions.get(mission.id)?.progress !== mission.progress
        || (afterStages.get(mission.id)?.length ?? 0) > 0
    )).map(mission => ({
        mission_id: mission.id,
        progress_value: mission.progress,
        stages: afterStages.get(mission.id) ?? [],
    }))
}

async function runLoadScenario(runtime, name) {
    const stable = name === "load-large-stable"
    return runtime.runIsolated({
        name,
        tableOverrides: tableOverrides(),
        setup: async ({ createFixturePlayer, createApp }) => {
            const player = createFixturePlayer(
                name === "load-new" ? "New" : "Large",
                800000501,
            )
            if (!stable) return player

            const app = await createLoadApp(createApp)
            const warmup = await postLoad(app, player)
            if (warmup.statusCode !== 200) {
                throw new Error(`load stable warmup failed: ${warmup.statusCode} ${warmup.body}`)
            }
            return { ...player, app }
        },
        execute: async ({ db, player, createApp, snapshotActiveMissionState }) => {
            const app = player.app ?? await createLoadApp(createApp)
            const before = snapshotActiveMissionState()
            const response = await postLoad(app, player)
            const after = snapshotActiveMissionState()
            if (stable && !runtime.ownersEqual(before, after)) {
                throw new Error("load-large-stable wrote Active Mission state")
            }
            return {
                ...runtime.behaviorSummary({ response, db, playerId: player.playerId }),
                activeMissionDelta: activeMissionDelta(before, after),
            }
        },
    })
}

async function runLoadRollback(runtime) {
    return runtime.runIsolated({
        name: "rollback-load",
        tableOverrides: tableOverrides(),
        setup: ({ db, createFixturePlayer }) => {
            const player = createFixturePlayer("Large", 800000502)
            db.exec(`
                CREATE TRIGGER fail_active_load_stage_insert
                BEFORE INSERT ON players_active_missions_stages
                WHEN NEW.player_id = ${player.playerId}
                BEGIN
                    SELECT RAISE(ABORT, '${LOAD_ROLLBACK_MARKER}');
                END
            `)
            return player
        },
        execute: async ({ player, createApp, snapshotActiveMissionState }) => {
            const app = await createLoadApp(createApp)
            const before = snapshotActiveMissionState()
            const response = await postLoad(app, player)
            const after = snapshotActiveMissionState()
            return runtime.isInjectedRollback({
                response,
                marker: LOAD_ROLLBACK_MARKER,
                before,
                after,
            })
        },
    })
}

module.exports = { runLoadRollback, runLoadScenario }
