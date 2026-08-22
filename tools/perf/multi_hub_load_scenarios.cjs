"use strict"

const crypto = require("node:crypto")
const { performance } = require("node:perf_hooks")
const questEntryCosts = require("../../assets/quest_entry_costs.json")

const {
    API_PREFIX,
    BOSS_QUEST,
    buildFinishPayload,
    completeScene,
    finishPlayer,
    leaveLobbyForBattle,
    normalizedRoomOutcome,
    openBattlePeers,
    openRoomParty,
    playerState,
    searchRoom,
    signUp,
    startPlayers,
} = require("../../tests/helpers/multi-hub-battle-flow")

const STAGE_TIMEOUT_MS = 15_000
const BOSS_ENTRY_COST = Object.freeze({
    ...questEntryCosts[`${BOSS_QUEST.category}_${BOSS_QUEST.questId}`],
})

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function contentType(response) {
    const headers = response?.headers
    if (typeof headers?.get === "function") {
        return String(headers.get("content-type") ?? "")
    }
    if (!isPlainObject(headers)) return ""
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")
    return String(entry?.[1] ?? "")
}

function isMsgpackResponse(response) {
    return contentType(response).toLowerCase().includes("application/x-msgpack")
}

function isMissionProgress(value) {
    return isPlainObject(value)
        && Number.isSafeInteger(value.mission_category)
        && value.mission_category > 0
        && Number.isSafeInteger(value.mission_id)
        && value.mission_id > 0
        && Number.isSafeInteger(value.progress_value)
        && value.progress_value >= 0
        && Number.isSafeInteger(value.stage)
        && value.stage > 0
}

function requireHttpSuccess(response, stage) {
    if (response?.status === 200 && response.body?.data_headers?.result_code === 1) return
    throw new Error(`${stage} failed`)
}

function throwIfAborted(signal) {
    signal?.throwIfAborted()
}

async function setStamina(harness, node, signal) {
    throwIfAborted(signal)
    const response = await harness.json(node.url, `/api/player/${node.playerId}/field`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "stamina", value: 100 }),
        signal,
    })
    throwIfAborted(signal)
    if (response.status !== 200) throw new Error("stamina setup failed")
    harness.withDatabase(node.dataKey, database => {
        const stored = database.prepare(`
            SELECT stamina_heal_time AS staminaHealTime
            FROM players
            WHERE id = ?
        `).get(node.playerId)?.staminaHealTime
        const anchorMs = new Date(stored).getTime()
        if (!Number.isFinite(anchorMs)) throw new Error("stamina setup failed")
        database.prepare(`
            UPDATE players
            SET stamina_heal_time = ?
            WHERE id = ?
        `).run(new Date(anchorMs - 1_000).toISOString(), node.playerId)
    })
}

function accountIdFor(harness, node) {
    return harness.withDatabase(node.dataKey, database => database.prepare(
        "SELECT account_id AS accountId FROM players WHERE id = ?",
    ).get(node.playerId)?.accountId, { readonly: true })
}

async function createIdentity(harness, runtimeNode, deviceId, active, signal) {
    throwIfAborted(signal)
    const node = { ...runtimeNode, deviceId }
    await signUp(harness, node, deviceId, { signal })
    throwIfAborted(signal)
    node.accountId = accountIdFor(harness, node)
    throwIfAborted(signal)
    if (!Number.isSafeInteger(node.accountId)) throw new Error("identity setup failed")
    if (active) await setStamina(harness, node, signal)
    throwIfAborted(signal)
    return node
}

async function createParticipants({ harness, profile, runtime, signal }) {
    throwIfAborted(signal)
    const count = profile.activeIdentities + 2
    const base = crypto.randomInt(100_000_000, 800_000_000 - count)
    const plan = Array.from({ length: profile.totalRooms }, (_, scenarioIndex) => ({
        scenarioIndex,
        ownerSide: scenarioIndex < profile.hostOwnedRooms ? "host" : "client",
    }))
    const scenarios = []
    for (const entry of plan) {
        throwIfAborted(signal)
        const host = await createIdentity(
            harness,
            runtime.host,
            base + entry.scenarioIndex * 2,
            true,
            signal,
        )
        throwIfAborted(signal)
        const client = await createIdentity(
            harness,
            runtime.client,
            base + entry.scenarioIndex * 2 + 1,
            true,
            signal,
        )
        throwIfAborted(signal)
        const nodes = entry.ownerSide === "host" ? [host, client] : [client, host]
        scenarios.push({ ...entry, nodes })
    }
    const spectatorBase = base + profile.activeIdentities
    const spectators = [
        await createIdentity(harness, runtime.host, spectatorBase, false, signal),
        await createIdentity(harness, runtime.client, spectatorBase + 1, false, signal),
    ]
    throwIfAborted(signal)
    return { scenarios, spectators }
}

function countActiveQuests({ harness, participants }) {
    return participants.scenarios.reduce((total, scenario) => total
        + scenario.nodes.reduce((sum, node) => sum + playerState(harness, node).activeQuests, 0), 0)
}

function responseCode(response) {
    const code = response?.body?.data_headers?.result_code
    return Number.isSafeInteger(code) && code >= 0 && code <= 999_999 ? code : "unknown"
}

function responseStatus(response) {
    const status = response?.status
    return Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : "unknown"
}

function coexistenceError(side, route, response) {
    return `${side} ${route} failed: HTTP ${responseStatus(response)}, result_code ${responseCode(response)}`
}

async function runAuth(harness, node) {
    const response = await harness.gamePost(node.url, "/api/index.php/tool/signup", {
        device_id: node.deviceId,
        channelNo: "multi-hub-load",
    })
    if (!isMsgpackResponse(response)
        || response?.status !== 200
        || response.body?.data_headers?.result_code !== 1
        || response.body?.data_headers?.viewer_id !== node.viewerId
        || response.body?.data?.newAccount !== 0) throw response
}

async function runLoad(harness, node) {
    const response = await harness.gamePost(node.url, "/api/index.php/load", {
        viewer_id: node.viewerId,
        keychain: node.viewerId,
        device_id: node.deviceId,
        device_token: "multi-hub-load",
        graphics_device_name: "load-runner",
        platform_os_version: "test",
        storage_directory_path: "",
    })
    const data = response?.body?.data
    if (!isMsgpackResponse(response)
        || response?.status !== 200
        || response.body?.data_headers?.result_code !== 1
        || response.body?.data_headers?.viewer_id !== node.accountId
        || response.body?.data_headers?.asset_update !== false
        || !isPlainObject(data)
        || !Array.isArray(data?.unfinished_quest_list)
        || data.unfinished_quest_list.length !== 0
        || !Array.isArray(data?.unfinished_multi_quest_list)
        || data.unfinished_multi_quest_list.length !== 0) throw response
}

async function runMission(harness, node) {
    const response = await harness.gamePost(
        node.url,
        "/api/index.php/mission/get_mission_progress",
        { viewer_id: node.viewerId, api_count: 1, category_list: [{ category: 1 }] },
    )
    const missionProgressList = response?.body?.data?.mission_progress_list
    if (!isMsgpackResponse(response)
        || response?.status !== 200
        || response.body?.data_headers?.result_code !== 1
        || response.body?.data_headers?.viewer_id !== node.viewerId
        || !Array.isArray(missionProgressList)
        || missionProgressList.length === 0
        || !missionProgressList.every(isMissionProgress)) throw response
}

async function runCoexistence(harness, spectators) {
    const summary = {
        attempted: 0,
        completed: 0,
        errors: 0,
        routes: { auth: 0, load: 0, mission: 0 },
        errorMessages: [],
    }
    const operations = { auth: runAuth, load: runLoad, mission: runMission }
    for (const [index, node] of spectators.entries()) {
        const side = index === 0 ? "host" : "client"
        for (const [route, operation] of Object.entries(operations)) {
            summary.attempted++
            summary.routes[route]++
            try {
                await bounded(
                    () => operation(harness, node),
                    STAGE_TIMEOUT_MS,
                    `${side} ${route}`,
                )
                summary.completed++
            } catch (response) {
                summary.errors++
                summary.errorMessages.push(coexistenceError(side, route, response))
            }
        }
    }
    return summary
}

async function heartbeatRoom(entry) {
    await Promise.all(entry.party.lobby.map(async ({ peer }) => {
        peer.send([0, [4]])
        await peer.waitFor(message => message[0] === 1 && message[1]?.[0] === 11, STAGE_TIMEOUT_MS)
    }))
}

function isSuccessful(response) {
    return response?.status === 200 && response.body?.data_headers?.result_code === 1
}

function requireStarted(before, after) {
    if (after[0].stamina !== before[0].stamina - BOSS_ENTRY_COST.stamina
        || after[1].stamina !== before[1].stamina
        || after.some(state => state.activeQuests !== 1)) throw new Error("start state failed")
}

function requireRewarded(before, afterStart, after) {
    if (after.rankPoint !== before.rankPoint + 399
        || after.freeMana < before.freeMana + 1290
        || after.stamina < afterStart.stamina
        || after.activeQuests !== 0) throw new Error("finish state failed")
}

async function executeBattle(harness, entry) {
    const [gameHost] = entry.scenario.nodes
    const before = entry.scenario.nodes.map(node => playerState(harness, node))
    entry.stage = "start"
    const playLabel = `scenario-${entry.scenario.scenarioIndex}`
    entry.playIds = new Map(entry.scenario.nodes.map(node => (
        [node.dataKey, `${playLabel}-${node.dataKey}`]
    )))
    entry.playIds = await startPlayers(
        harness,
        entry.scenario.nodes,
        entry.party.roomNumber,
        BOSS_QUEST,
        playLabel,
    )
    const afterStart = entry.scenario.nodes.map(node => playerState(harness, node))
    requireStarted(before, afterStart)

    entry.stage = "battle open"
    entry.battle = await openBattlePeers(
        harness,
        entry.party.lobby,
        entry.party.roomNumber,
        `battle-${entry.scenario.scenarioIndex}`,
        STAGE_TIMEOUT_MS,
    )
    entry.stage = "lobby leave"
    await leaveLobbyForBattle(entry.party.lobby, STAGE_TIMEOUT_MS)
    entry.stage = "scene ready"
    await completeScene(entry.battle)

    entry.stage = "early finish"
    const beforeEarly = playerState(harness, gameHost)
    const early = await harness.gamePost(gameHost.url, `${API_PREFIX}/finish`, buildFinishPayload(
        gameHost,
        entry.party.roomNumber,
        BOSS_QUEST,
        entry.playIds.get(gameHost.dataKey),
    ))
    if (isSuccessful(early) || playerState(harness, gameHost).activeQuests !== 1
        || !require("node:util").isDeepStrictEqual(playerState(harness, gameHost), beforeEarly)) {
        throw new Error("early finish state failed")
    }

    entry.stage = "finalize"
    entry.battle.forEach(peer => peer.send([0, [1]]))
    await completeScene(entry.battle)
    entry.battle.forEach(peer => peer.send([0, [2]]))
    await Promise.all(entry.battle.map(peer => peer.waitFor(
        message => message[0] === 1 && message[1]?.[0] === 2,
        STAGE_TIMEOUT_MS,
    )))

    entry.stage = "finish"
    const settledStates = []
    for (const node of entry.scenario.nodes) {
        settledStates.push(await finishPlayer(harness, node, {
            roomNumber: entry.party.roomNumber,
            quest: BOSS_QUEST,
            playId: entry.playIds.get(node.dataKey),
            timeoutMs: STAGE_TIMEOUT_MS,
        }))
    }
    const firstStates = settledStates.map(state => ({
        ...state.player,
        activeQuests: state.activeQuests.length,
    }))
    firstStates.forEach((state, index) => requireRewarded(
        before[index],
        afterStart[index],
        state,
    ))
    return normalizedRoomOutcome({
        ownerSide: entry.scenario.ownerSide,
        hostRewarded: true,
        guestRewarded: true,
        duplicateFinishRejected: 2,
    })
}

async function bounded(task, timeoutMs, stage) {
    let timer
    try {
        return await Promise.race([
            task(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${stage} timed out`)), timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

function asError(value, fallbackMessage) {
    return value instanceof Error ? value : new Error(fallbackMessage)
}

function aggregateFailures(primary, cleanupErrors, message) {
    const primaryError = asError(primary, message)
    const errors = cleanupErrors.map(error => asError(error, "room cleanup failed"))
    return new AggregateError([primaryError, ...errors], message, { cause: primaryError })
}

function validateStageTimeout(stageTimeoutMs) {
    if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs <= 0) {
        throw new TypeError("stageTimeoutMs must be a positive safe integer")
    }
}

async function cleanupEntry(harness, entry, {
    stageTimeoutMs = STAGE_TIMEOUT_MS,
    stateReader = (activeHarness, node) => playerState(activeHarness, node),
    searchRunner = searchRoom,
} = {}) {
    validateStageTimeout(stageTimeoutMs)
    const errors = []
    const peers = [
        ...(entry.battle ?? []),
        ...(entry.party?.lobby ?? []).map(member => member.peer),
    ]
    const peerResults = await Promise.allSettled(peers.map(peer => (
        bounded(() => peer.close(), stageTimeoutMs, "peer cleanup")
    )))
    for (const result of peerResults) {
        if (result.status === "rejected") {
            errors.push(asError(result.reason, "peer cleanup failed"))
        }
    }
    if (entry.party && entry.playIds) {
        for (const node of [...entry.scenario.nodes].reverse()) {
            try {
                if (stateReader(harness, node).activeQuests === 0) continue
                const response = await bounded(() => harness.gamePost(
                    node.url,
                    `${API_PREFIX}/abort`,
                    {
                        viewer_id: node.viewerId,
                        api_count: 1,
                        quest_id: BOSS_QUEST.questId,
                        category: BOSS_QUEST.category,
                        room_number: entry.party.roomNumber,
                        play_id: entry.playIds.get(node.dataKey),
                    },
                ), stageTimeoutMs, "abort cleanup")
                requireHttpSuccess(response, "abort cleanup")
                if (stateReader(harness, node).activeQuests !== 0) {
                    throw new Error("abort cleanup failed")
                }
            } catch (error) {
                errors.push(asError(error, "abort cleanup failed"))
            }
        }
    }
    if (!entry.party) return { remainingRoom: false, errors }
    try {
        const gameHost = entry.scenario.nodes[0]
        const response = await bounded(() => harness.gamePost(
            gameHost.url,
            `${API_PREFIX}/disband_room`,
            {
                viewer_id: gameHost.viewerId,
                api_count: 1,
                room_number: entry.party.roomNumber,
            },
        ), stageTimeoutMs, "disband cleanup")
        requireHttpSuccess(response, "disband cleanup")
    } catch (error) {
        errors.push(asError(error, "disband cleanup failed"))
    }
    let remainingRoom = true
    try {
        const searched = await bounded(() => searchRunner(
            harness,
            entry.scenario.nodes[0],
            entry.party.roomNumber,
        ), stageTimeoutMs, "room search cleanup")
        requireHttpSuccess(searched, "room search cleanup")
        const roomExists = searched.body?.data?.room_exists
        if (typeof roomExists !== "boolean") throw new Error("room search cleanup failed")
        remainingRoom = roomExists
        if (roomExists) errors.push(new Error("room cleanup failed"))
    } catch (error) {
        errors.push(asError(error, "room search cleanup failed"))
    }
    return { remainingRoom, errors }
}

async function settleEntry(harness, entry, {
    battleRunner = executeBattle,
    cleanupRunner = cleanupEntry,
} = {}) {
    let outcome = null
    let caught = null
    try {
        outcome = await bounded(() => battleRunner(harness, entry), 45_000, "room lifecycle")
    } catch (error) {
        caught = asError(error, `${entry.stage} failed`)
    }
    let cleanup = { remainingRoom: true, errors: [] }
    try {
        cleanup = await cleanupRunner(harness, entry)
    } catch (error) {
        cleanup = {
            remainingRoom: true,
            errors: [asError(error, "room cleanup failed")],
        }
    }
    if (cleanup.errors.length > 0) {
        outcome = null
        if (caught) {
            caught = aggregateFailures(caught, cleanup.errors, `${entry.stage} failed`)
        }
        else {
            const cleanupErrors = cleanup.errors.map(error => (
                asError(error, "room cleanup failed")
            ))
            caught = new AggregateError(cleanupErrors, "room cleanup failed", {
                cause: cleanupErrors[0],
            })
            entry.stage = "cleanup"
        }
    }
    return {
        scenarioIndex: entry.scenario.scenarioIndex,
        durationMs: performance.now() - entry.startedAt,
        outcome,
        error: caught,
        stage: caught ? entry.stage : undefined,
        remainingRoom: cleanup.remainingRoom,
    }
}

async function runScenarioBatch({
    harness,
    scenarios,
    spectators,
    stageTimeoutMs = STAGE_TIMEOUT_MS,
    openParty = (activeHarness, scenario) => openRoomParty(
        activeHarness,
        scenario.nodes,
        BOSS_QUEST,
        `scenario-${scenario.scenarioIndex}`,
        "select",
        stageTimeoutMs,
    ),
    coexistenceRunner = runCoexistence,
    heartbeatRunner = heartbeatRoom,
    cleanupRunner = cleanupEntry,
    settleRunner = settleEntry,
}) {
    validateStageTimeout(stageTimeoutMs)
    const entered = []
    const failed = []
    const enterResults = await Promise.allSettled(scenarios.map(async scenario => ({
        scenario,
        startedAt: performance.now(),
        stage: "enter",
        party: await bounded(
            () => openParty(harness, scenario),
            stageTimeoutMs,
            "enter",
        ),
    })))
    enterResults.forEach((result, index) => {
        if (result.status === "fulfilled") entered.push(result.value)
        else failed.push({
            scenarioIndex: scenarios[index].scenarioIndex,
            durationMs: 0,
            outcome: null,
            error: result.reason,
            stage: "enter",
            remainingRoom: false,
        })
    })

    const coexistence = await coexistenceRunner(harness, spectators)
    const heartbeatResults = await Promise.allSettled(entered.map(heartbeatRunner))
    const ready = []
    for (let index = 0; index < heartbeatResults.length; index++) {
        if (heartbeatResults[index].status === "fulfilled") ready.push(entered[index])
        else {
            entered[index].stage = "heartbeat"
            let cleanup = { remainingRoom: true, errors: [] }
            let error = asError(heartbeatResults[index].reason, "heartbeat failed")
            try {
                cleanup = await cleanupRunner(harness, entered[index], { stageTimeoutMs })
            } catch (cleanupError) {
                cleanup = {
                    remainingRoom: true,
                    errors: [asError(cleanupError, "room cleanup failed")],
                }
            }
            if (cleanup.errors.length > 0) {
                error = aggregateFailures(error, cleanup.errors, "heartbeat failed")
            }
            failed.push({
                scenarioIndex: entered[index].scenario.scenarioIndex,
                durationMs: performance.now() - entered[index].startedAt,
                outcome: null,
                error,
                stage: "heartbeat",
                remainingRoom: cleanup.remainingRoom,
            })
        }
    }
    const settled = await Promise.allSettled(ready.map(entry => settleRunner(harness, entry)))
    settled.forEach((result, index) => {
        if (result.status === "fulfilled") failed.push(result.value)
        else failed.push({
            scenarioIndex: ready[index].scenario.scenarioIndex,
            durationMs: performance.now() - ready[index].startedAt,
            outcome: null,
            error: asError(result.reason, `${ready[index].stage} failed`),
            stage: ready[index].stage,
            remainingRoom: true,
        })
    })
    return { rooms: failed, coexistence }
}

module.exports = {
    BOSS_ENTRY_COST,
    cleanupEntry,
    countActiveQuests,
    createParticipants,
    runCoexistence,
    runScenarioBatch,
    requireRewarded,
    requireStarted,
    settleEntry,
}
