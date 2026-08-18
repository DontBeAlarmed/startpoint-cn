"use strict"

const officialMissions = require("../../../assets/mission_active.json")
const officialEvents = require("../../../assets/mission_active_event.json")
const officialRewards = require("../../../assets/mission_active_reward.json")

const RECEIVE_EVENT_ID = 992
const FIRST_MISSION_ID = 99201
const FIRST_ITEM_ID = 992001
const RECEIVE_ROLLBACK_MARKER = "ACTIVE_MISSION_RECEIVE_REWARD_ROLLBACK_34_2"

function missionRow(missionId) {
    const row = []
    row[0] = String(RECEIVE_EVENT_ID)
    row[1] = "1"
    row[3] = `active_mission_focused_receive_${missionId}`
    row[29] = "0"
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    return row
}

function eventRow() {
    const row = []
    row[0] = "active_mission_focused_receive_event"
    row[2] = "0"
    row[3] = "1"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "(None)"
    row[22] = "(None)"
    return row
}

function rewardRow(itemId) {
    const row = []
    row[3] = "1"
    row[4] = "(None)"
    row[7] = "1"
    row[8] = "1"
    row[9] = String(itemId)
    return row
}

function missionIds(count) {
    return Array.from({ length: count }, (_value, index) => FIRST_MISSION_ID + index)
}

function tableOverrides(count) {
    const ids = missionIds(count)
    if (officialEvents[RECEIVE_EVENT_ID] || ids.some(id => officialMissions[id])) {
        throw new Error("focused receive fixture collides with official Active Mission content")
    }
    return {
        "mission_active.json": {
            ...officialMissions,
            ...Object.fromEntries(ids.map(id => [id, [missionRow(id)]])),
        },
        "mission_active_event.json": {
            ...officialEvents,
            [RECEIVE_EVENT_ID]: [eventRow()],
        },
        "mission_active_reward.json": {
            ...officialRewards,
            ...Object.fromEntries(ids.map((id, index) => [
                id,
                { 1: [rewardRow(FIRST_ITEM_ID + index)] },
            ])),
        },
    }
}

async function createReceiveApp(createApp) {
    const route = require("../../../src/routes/api/activeMission").default
    return createApp(route, { prefix: "/api/index.php/active_mission" })
}

function postReceive(runtime, app, player, ids) {
    return app.inject({
        method: "POST",
        url: "/api/index.php/active_mission/receive",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: runtime.encodeRequest({
            viewer_id: player.viewerId,
            api_count: 1,
            active_mission_list: ids.map(missionId => ({ mission_id: missionId, stages: [1] })),
        }),
    })
}

function seedClaimableMissions(missionDomain, playerId, ids) {
    for (const missionId of ids) {
        missionDomain.updatePlayerActiveMissionSync(playerId, missionId, 1)
        missionDomain.updatePlayerActiveMissionStageSync(playerId, 1, missionId, false)
    }
}

async function runReceiveScenario(runtime, count) {
    const ids = missionIds(count)
    return runtime.runIsolated({
        name: `receive-batch-${count}`,
        tableOverrides: tableOverrides(count),
        setup: ({ createPlayer, missionDomain }) => {
            const player = createPlayer(`receive-batch-${count}`, 800000600 + count)
            seedClaimableMissions(missionDomain, player.playerId, ids)
            return player
        },
        execute: async ({ db, player, createApp }) => {
            const app = await createReceiveApp(createApp)
            const response = await postReceive(runtime, app, player, ids)
            return runtime.behaviorSummary({ response, db, playerId: player.playerId })
        },
    })
}

async function runReceiveRollback(runtime) {
    const count = 8
    const ids = missionIds(count)
    const lastItemId = FIRST_ITEM_ID + count - 1
    return runtime.runIsolated({
        name: "rollback-receive",
        tableOverrides: tableOverrides(count),
        setup: ({ db, createPlayer, missionDomain }) => {
            const player = createPlayer("rollback-receive", 800000699)
            seedClaimableMissions(missionDomain, player.playerId, ids)
            db.exec(`
                CREATE TRIGGER fail_last_active_reward_owner_write
                BEFORE INSERT ON players_items
                WHEN NEW.player_id = ${player.playerId} AND NEW.id = ${lastItemId}
                BEGIN
                    SELECT RAISE(ABORT, '${RECEIVE_ROLLBACK_MARKER}');
                END
            `)
            return player
        },
        execute: async ({ player, createApp, snapshotOwner }) => {
            const app = await createReceiveApp(createApp)
            const before = snapshotOwner()
            const response = await postReceive(runtime, app, player, ids)
            const after = snapshotOwner()
            return runtime.isInjectedRollback({
                response,
                marker: RECEIVE_ROLLBACK_MARKER,
                before,
                after,
            })
        },
    })
}

module.exports = { runReceiveRollback, runReceiveScenario }
