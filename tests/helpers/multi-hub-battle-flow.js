"use strict"

const { types: { isProxy } } = require("node:util")

const {
    defaultCompatibilityHeaders,
    preparedTcpEndpoint,
} = require("./multi-hub-process-harness")
const {
    buildFinishPayload,
    finishPlayer,
    settlementSnapshotAudit,
    snapshotSettlementState,
} = require("./multi-hub-settlement-state")

const API_PREFIX = "/api/index.php/multi_battle_quest"
const BOSS_QUEST = Object.freeze({ category: 2, questId: 1001002 })
const DEFAULT_TASK_TIMEOUT_MS = 5_000
const LIMITED_ERROR = Symbol("limitedError")
const ROOM_OUTCOME_FIELDS = Object.freeze([
    "ownerSide",
    "hostRewarded",
    "guestRewarded",
    "duplicateFinishRejected",
])

function limitedError(message, ErrorType = Error) {
    const error = new ErrorType(message)
    Object.defineProperty(error, LIMITED_ERROR, { value: true })
    return error
}

function stageError(stage, outcome = "failed", ErrorType = Error) {
    return limitedError(`${stage} ${outcome}`, ErrorType)
}

function limitedStageError(error, stage, outcome = "failed") {
    return error?.[LIMITED_ERROR] === true ? error : stageError(stage, outcome)
}

function validateTimeout(timeoutMs, stage) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw stageError(`${stage} timeout validation`, "failed", TypeError)
    }
}

async function runTaskWithinTimeout(task, stage, timeoutMs) {
    validateTimeout(timeoutMs, stage)
    let timer
    const observed = Promise.resolve().then(task).then(
        value => ({ status: "fulfilled", value }),
        () => ({ status: "rejected" }),
    )
    const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve({ status: "timedOut" }), timeoutMs)
    })
    const result = await Promise.race([observed, timedOut])
    clearTimeout(timer)
    if (result.status === "fulfilled") return result.value
    if (result.status === "rejected") throw stageError(stage)
    throw stageError(stage, "timed out")
}

async function runStage(stage, operation) {
    try {
        return await operation()
    } catch (error) {
        throw limitedStageError(error, stage)
    }
}

function runStageSync(stage, operation) {
    try {
        return operation()
    } catch (error) {
        throw limitedStageError(error, stage)
    }
}

async function waitForStage(peer, predicate, stage, timeoutMs) {
    const boundedTimeoutMs = timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    return runTaskWithinTimeout(
        () => peer.waitFor(predicate, boundedTimeoutMs),
        stage,
        boundedTimeoutMs,
    )
}

async function openTcpStage(harness, args, stage, timeoutMs) {
    return runTaskWithinTimeout(
        () => harness.openTcp(...args, timeoutMs),
        stage,
        timeoutMs,
    )
}

function buildRoomParty() {
    return {
        characters: [[0, {
            id: 1,
            evolution_level: 0,
            exp: 10,
            over_limit_step: 0,
            mana_node_ids: {},
            ex_boost: [1],
            illustration_settings: [1],
        }], [1], [1]],
        unison_characters: [[1], [1], [1]],
        equipments: [[1], [1], [1]],
        abilitySoulIds: [[1], [1], [1]],
    }
}

function buildStartPayload(node, roomNumber, quest, playId) {
    return {
        viewer_id: node.viewerId,
        api_count: 1,
        quest_id: quest.questId,
        category: quest.category,
        party_id: 1,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
        room_number: roomNumber,
        mate_player_ids: [],
        mate_party_ids: [],
        play_id: playId,
        combat_power: 1,
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
        return false
    }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasExactDataFields(value, expectedFields) {
    if (!isPlainObject(value)) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedFields.length) return false
    const expected = new Set(expectedFields)
    return keys.every(key => {
        if (typeof key !== "string" || !expected.has(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor?.enumerable === true && "value" in descriptor
    })
}

function normalizedRoomOutcome(outcome) {
    if (!hasExactDataFields(outcome, ROOM_OUTCOME_FIELDS)
        || (outcome.ownerSide !== "host" && outcome.ownerSide !== "client")
        || typeof outcome.hostRewarded !== "boolean"
        || typeof outcome.guestRewarded !== "boolean"
        || !Number.isSafeInteger(outcome.duplicateFinishRejected)
        || outcome.duplicateFinishRejected < 0) {
        throw new TypeError("room outcome is not a normalized multiplayer behavior result")
    }
    return Object.freeze({
        ownerSide: outcome.ownerSide,
        hostRewarded: outcome.hostRewarded,
        guestRewarded: outcome.guestRewarded,
        duplicateFinishRejected: outcome.duplicateFinishRejected,
    })
}

function requireHttpSuccess(response, stage) {
    if (response?.status === 200) return
    const status = Number.isSafeInteger(response?.status)
        && response.status >= 100
        && response.status <= 599
        ? response.status
        : "unknown"
    const rawResultCode = response?.body?.data_headers?.result_code
    const resultCode = Number.isSafeInteger(rawResultCode)
        && rawResultCode >= 0
        && rawResultCode <= 999_999
        ? `, result_code ${rawResultCode}`
        : ""
    throw limitedError(`${stage} failed: HTTP ${status}${resultCode}`)
}

async function signUp(harness, node, deviceId, { signal } = {}) {
    signal?.throwIfAborted()
    const response = await runStage("signup request", () => harness.gamePost(
        node.url,
        "/api/index.php/tool/signup",
        {
            device_id: deviceId,
            channelNo: "multi-hub-process",
        },
        {},
        { signal },
    ))
    signal?.throwIfAborted()
    requireHttpSuccess(response, "signup")
    const viewerId = response?.body?.data_headers?.viewer_id
    if (viewerId === undefined || viewerId === null) {
        throw stageError("signup response")
    }
    signal?.throwIfAborted()
    const players = runStageSync("signup player lookup", () => harness.withDatabase(
        node.dataKey,
        database => database.prepare(`
            SELECT players.id
            FROM sessions
            JOIN players ON players.account_id = sessions.account_id
            WHERE sessions.token = ?
        `).all(String(viewerId)),
        { readonly: true },
    ))
    if (players.length !== 1) {
        throw stageError("signup player lookup")
    }
    signal?.throwIfAborted()
    node.viewerId = viewerId
    node.playerId = players[0].id
}

function playerState(harness, node, { ticketItemId } = {}) {
    if (ticketItemId !== undefined
        && (!Number.isSafeInteger(ticketItemId) || ticketItemId <= 0)) {
        throw stageError("player state validation", "failed", TypeError)
    }
    return runStageSync("player state", () => harness.withDatabase(node.dataKey, database => {
        const player = database.prepare(`
            SELECT stamina, free_mana AS freeMana, rank_point AS rankPoint
            FROM players WHERE id = ?
        `).get(node.playerId)
        const activeQuests = database.prepare(`
            SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?
        `).get(node.playerId).count
        if (ticketItemId === undefined) return { ...player, activeQuests }
        const ticket = database.prepare(`
            SELECT amount FROM players_items WHERE player_id = ? AND id = ?
        `).get(node.playerId, ticketItemId)?.amount ?? 0
        return { ...player, ticket, activeQuests }
    }, { readonly: true }))
}

async function createRoom(harness, host, quest, apiCount) {
    const response = await runStage("create room request", () => harness.gamePost(
        host.url,
        `${API_PREFIX}/create_room`,
        {
            viewer_id: host.viewerId,
            api_count: apiCount,
            category: quest.category,
            quest_id: quest.questId,
            party_id: 1,
        },
    ))
    requireHttpSuccess(response, "create room")
    return response.body.data.room_number
}

async function searchRoom(harness, node, roomNumber, headers = defaultCompatibilityHeaders) {
    return runStage("search room request", () => harness.gamePost(node.url, `${API_PREFIX}/search_room`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
    }, headers))
}

async function prepareRoom(harness, node, roomNumber, quest) {
    return runStage("prepare room request", () => harness.gamePost(node.url, `${API_PREFIX}/prepare`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
        category: quest.category,
        quest_id: quest.questId,
    }))
}

async function selectRoom(harness, node, roomNumber, quest) {
    return runStage("select room request", () => harness.gamePost(node.url, `${API_PREFIX}/select_room`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
        category: quest.category,
        quest_id: quest.questId,
        party_id: 1,
        accepted_type: 0,
    }))
}

async function disbandRoom(harness, host, roomNumber) {
    const response = await runStage("disband room request", () => harness.gamePost(host.url, `${API_PREFIX}/disband_room`, {
        viewer_id: host.viewerId,
        api_count: 1,
        room_number: roomNumber,
    }))
    requireHttpSuccess(response, "disband room")
}

async function throwAfterCleanup(
    primaryError,
    stage,
    cleanupTasks,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
) {
    validateTimeout(timeoutMs, stage)
    const results = await Promise.allSettled(cleanupTasks.map((task, index) => (
        runTaskWithinTimeout(task, `${stage} cleanup ${index + 1}`, timeoutMs)
    )))
    const primary = limitedStageError(primaryError, stage)
    const cleanupErrors = results.flatMap(result => result.status === "rejected"
        ? [result.reason]
        : [])
    if (cleanupErrors.length === 0) throw primary
    const aggregate = new AggregateError(
        [primary, ...cleanupErrors],
        primary.message,
        { cause: primary },
    )
    Object.defineProperty(aggregate, LIMITED_ERROR, { value: true })
    throw aggregate
}

async function enterRoom(harness, node, roomNumber, quest, endpoint, suffix, timeoutMs) {
    const connectionId = `${node.dataKey}-${suffix}`
    let peer
    try {
        peer = await openTcpStage(harness, [
            `${connectionId}-lobby`, endpoint.host, endpoint.port, {
                socklet: "cooperation_room",
                room_number: roomNumber,
                viewerId: node.viewerId,
                connection_id: connectionId,
                questCategory: quest.category,
                questId: quest.questId,
            },
        ], "lobby open", timeoutMs)
        await waitForStage(
            peer,
            message => message[0] === 0 && message[1] === connectionId,
            "lobby handshake",
            timeoutMs,
        )
        runStageSync("lobby party send", () => peer.send([
            0,
            [0, { party: buildRoomParty(), currentPartyId: 1 }],
        ]))
        await waitForStage(
            peer,
            message => message[0] === 1 && message[1]?.[0] === 0,
            "lobby party wait",
            timeoutMs,
        )
        return { peer, connectionId, endpoint }
    } catch (error) {
        if (!peer) throw limitedStageError(error, "lobby open")
        await throwAfterCleanup(error, "enter room", [() => peer.close()], timeoutMs)
    }
}

async function openRoomParty(
    harness,
    nodes,
    quest,
    suffix,
    admissionRoute = "select",
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
) {
    validateTimeout(timeoutMs, "room")
    let roomNumber
    const lobby = []
    try {
        roomNumber = await createRoom(harness, nodes[0], quest, suffix.length)
        for (const [index, node] of nodes.entries()) {
            if (index > 0 && admissionRoute === "select") {
                const searched = await searchRoom(harness, node, roomNumber)
                if (searched?.body?.data?.room_exists !== true) {
                    throw stageError("room search")
                }
            }
            const admitted = admissionRoute === "prepare"
                ? await prepareRoom(harness, node, roomNumber, quest)
                : await selectRoom(harness, node, roomNumber, quest)
            const endpoint = runStageSync(
                "lobby endpoint",
                () => preparedTcpEndpoint(admitted, roomNumber),
            )
            lobby.push(await enterRoom(
                harness,
                node,
                roomNumber,
                quest,
                endpoint,
                suffix,
                timeoutMs,
            ))
        }
        nodes.slice(1).forEach((_node, index) => runStageSync(
            "lobby ready send",
            () => lobby[index + 1].peer.send([0, [3, [1]]]),
        ))
        runStageSync("lobby start send", () => lobby[0].peer.send([0, [6]]))
        await Promise.all(lobby.map(({ peer }) => (
            waitForStage(
                peer,
                message => message[0] === 1 && message[1]?.[0] === 5,
                "lobby ready wait",
                timeoutMs,
            )
        )))
        return { roomNumber, lobby }
    } catch (error) {
        const cleanupTasks = lobby.map(({ peer }) => () => peer.close())
        if (roomNumber !== undefined && roomNumber !== null) {
            cleanupTasks.push(() => disbandRoom(harness, nodes[0], roomNumber))
        }
        await throwAfterCleanup(error, "open room party", cleanupTasks, timeoutMs)
    }
}

async function startPlayers(harness, nodes, roomNumber, quest, label) {
    const playIds = new Map()
    for (const node of nodes) {
        const playId = `${label}-${node.dataKey}`
        const response = await runStage("start player request", () => harness.gamePost(
            node.url,
            `${API_PREFIX}/start`,
            buildStartPayload(node, roomNumber, quest, playId),
        ))
        requireHttpSuccess(response, "start player")
        playIds.set(node.dataKey, playId)
    }
    return playIds
}

async function openBattlePeers(
    harness,
    lobby,
    roomNumber,
    suffix,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
) {
    validateTimeout(timeoutMs, "battle")
    const battle = []
    try {
        for (const member of lobby) {
            const peer = await openTcpStage(harness, [
                `${member.connectionId}-${suffix}`, member.endpoint.host, member.endpoint.port, {
                    socklet: "cooperation_battle",
                    room_number: roomNumber,
                    connection_id: member.connectionId,
                },
            ], "battle open", timeoutMs)
            battle.push(peer)
            await waitForStage(
                peer,
                message => message[0] === 0 && message[1] === roomNumber,
                "battle handshake",
                timeoutMs,
            )
        }
        return battle
    } catch (error) {
        await throwAfterCleanup(
            error,
            "open battle peers",
            battle.map(peer => () => peer.close()),
            timeoutMs,
        )
    }
}

async function completeScene(peers) {
    peers.forEach(peer => runStageSync("battle scene send", () => peer.send([0, [0]])))
    await Promise.all(peers.map(peer => (
        waitForStage(
            peer,
            message => message[0] === 1 && message[1]?.[0] === 1,
            "battle scene wait",
        )
    )))
}

async function leaveLobbyForBattle(
    lobby,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    cleanupTimeoutMs = timeoutMs,
) {
    validateTimeout(timeoutMs, "leave lobby")
    validateTimeout(cleanupTimeoutMs, "leave lobby cleanup")
    try {
        lobby.forEach(({ peer }) => runStageSync(
            "leave lobby send",
            () => peer.send([0, [1]]),
        ))
        await runTaskWithinTimeout(
            () => Promise.all(lobby.map(({ peer }) => peer.closedPromise)),
            "leave lobby for battle",
            timeoutMs,
        )
    } catch (error) {
        await throwAfterCleanup(
            error,
            "leave lobby for battle",
            lobby.map(({ peer }) => () => peer.close()),
            cleanupTimeoutMs,
        )
    }
}

module.exports = {
    API_PREFIX,
    BOSS_QUEST,
    buildFinishPayload,
    buildRoomParty,
    buildStartPayload,
    completeScene,
    createRoom,
    disbandRoom,
    finishPlayer,
    leaveLobbyForBattle,
    normalizedRoomOutcome,
    openBattlePeers,
    openRoomParty,
    playerState,
    prepareRoom,
    searchRoom,
    settlementSnapshotAudit,
    signUp,
    snapshotSettlementState,
    startPlayers,
}
