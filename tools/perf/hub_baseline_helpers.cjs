"use strict"

const { performance } = require("node:perf_hooks")

const {
    preparedTcpEndpoint,
} = require("../../tests/helpers/multi-hub-process-harness")

const API_PREFIX = "/api/index.php/multi_battle_quest"
const QUEST = Object.freeze({ category: 8, questId: 1001 })

function requireResponse(response, label) {
    if (response.status !== 200) {
        throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`)
    }
    return response.body?.data
}

async function signUp(harness, node, deviceId) {
    const response = await harness.gamePost(node.url, "/api/index.php/tool/signup", {
        channelNo: "hub-baseline",
        device_id: deviceId,
    }, {})
    if (response.status !== 200) {
        const processOutput = harness.processes.map(runtime => runtime.output()).join("\n")
        throw new Error(`${node.dataKey} signup failed with HTTP ${response.status}: ${JSON.stringify(response.body)}\n${processOutput}`)
    }
    const data = requireResponse(response, `${node.dataKey} signup`)
    const viewerId = response.body?.data_headers?.viewer_id
    if (!Number.isSafeInteger(viewerId) || viewerId <= 0 || !data) {
        throw new Error(`${node.dataKey} signup returned an invalid viewer id`)
    }
    node.viewerId = viewerId
}

async function createRoom(harness, host, apiCount) {
    const response = await harness.gamePost(host.url, `${API_PREFIX}/create_room`, {
        api_count: apiCount,
        category: QUEST.category,
        party_id: 1,
        quest_id: QUEST.questId,
        viewer_id: host.viewerId,
    })
    const data = requireResponse(response, "create room")
    if (typeof data?.room_number !== "string" || data.room_number.length === 0) {
        throw new Error("create room returned no room number")
    }
    return data.room_number
}

async function prepareRoom(harness, node, roomNumber) {
    const response = await harness.gamePost(node.url, `${API_PREFIX}/prepare`, {
        api_count: 1,
        category: QUEST.category,
        quest_id: QUEST.questId,
        room_number: roomNumber,
        viewer_id: node.viewerId,
    })
    const data = requireResponse(response, `${node.dataKey} prepare`)
    return preparedTcpEndpoint({ status: response.status, body: { data } }, roomNumber)
}

function assertSameEndpoint(hostEndpoint, clientEndpoint) {
    if (hostEndpoint.host !== clientEndpoint.host || hostEndpoint.port !== clientEndpoint.port) {
        throw new Error("Host and Client prepare returned different TCP endpoints")
    }
}

async function openPeer(harness, node, endpoint, roomNumber, role, timeoutMs) {
    const connectionId = `hub-perf-${node.dataKey}-${role}-${roomNumber}`
    const startedAt = performance.now()
    let peer = null
    try {
        peer = await harness.openTcp(
            connectionId,
            endpoint.host,
            endpoint.port,
            {
                connection_id: connectionId,
                questCategory: QUEST.category,
                questId: QUEST.questId,
                room_number: roomNumber,
                socklet: "cooperation_room",
                viewerId: node.viewerId,
            },
            timeoutMs,
        )
        await peer.waitFor(message => message[0] === 0 && message[1] === connectionId, timeoutMs)
        const handshakeMs = performance.now() - startedAt
        const heartbeatStartedAt = performance.now()
        peer.send([0, [4]])
        await peer.waitFor(
            message => message[0] === 1 && message[1]?.[0] === 11,
            timeoutMs,
        )
        return {
            error: null,
            handshakeMs,
            heartbeatMs: performance.now() - heartbeatStartedAt,
            peer,
        }
    } catch (error) {
        return {
            error: String(error?.message ?? error),
            handshakeMs: null,
            heartbeatMs: null,
            peer,
        }
    }
}

async function disbandRoom(harness, host, roomNumber) {
    const response = await harness.gamePost(host.url, `${API_PREFIX}/disband_room`, {
        api_count: 1,
        room_number: roomNumber,
        viewer_id: host.viewerId,
    })
    requireResponse(response, "disband room")
}

async function roomStillExists(harness, host, roomNumber) {
    const response = await harness.gamePost(host.url, `${API_PREFIX}/search_room`, {
        api_count: 1,
        room_number: roomNumber,
        viewer_id: host.viewerId,
    })
    const data = requireResponse(response, "search room")
    return data?.room_exists === true
}

module.exports = {
    API_PREFIX,
    QUEST,
    assertSameEndpoint,
    createRoom,
    disbandRoom,
    openPeer,
    prepareRoom,
    roomStillExists,
    signUp,
}
