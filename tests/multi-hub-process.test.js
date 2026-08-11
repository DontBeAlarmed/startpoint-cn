"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    MultiHubProcessHarness,
    defaultCompatibilityHeaders,
    preparedTcpEndpoint,
    reserveLoopbackPorts,
} = require("./helpers/multi-hub-process-harness")

const apiPrefix = "/api/index.php/multi_battle_quest"
const timedQuest = Object.freeze({ category: 8, questId: 1001 })
const ticketQuest = Object.freeze({ category: 13, questId: 2001, itemId: 500000 })
const bothBossQuest = Object.freeze({ category: 2, questId: 1001002 })

function roomParty() {
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

function startPayload(node, roomNumber, quest, playId) {
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

function finishPayload(node, roomNumber, quest, playId) {
    return {
        viewer_id: node.viewerId,
        api_count: 1,
        quest_id: quest.questId,
        category: quest.category,
        room_number: roomNumber,
        play_id: playId,
        score: 0,
        elapsed_time_ms: 1_000,
        add_mana: 0,
        is_accomplished: true,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{ use_power_flip_count: 1 }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
        mate_player_result: [],
    }
}

async function signUp(harness, node, deviceId) {
    const response = await harness.gamePost(node.url, "/api/index.php/tool/signup", {
        device_id: deviceId,
        channelNo: "multi-hub-process",
    }, {})
    assert.equal(response.status, 200, JSON.stringify(response.body))
    node.viewerId = response.body.data_headers.viewer_id
    node.playerId = harness.withDatabase(node.dataKey, database => (
        database.prepare("SELECT id FROM players ORDER BY id LIMIT 1").get().id
    ), { readonly: true })
}

async function setTime(harness, node, value) {
    const response = await harness.json(
        node.url,
        `/api/server/time?time=${encodeURIComponent(value)}`,
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
}

async function setPlayerField(harness, node, field, value) {
    const response = await harness.json(node.url, `/api/player/${node.playerId}/field`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field, value }),
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
}

async function setItem(harness, node, itemId, count) {
    const response = await harness.json(node.url, `/api/player/${node.playerId}/item`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: itemId, count }),
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
}

function playerState(harness, node) {
    return harness.withDatabase(node.dataKey, database => {
        const player = database.prepare(`
            SELECT stamina, free_mana AS freeMana, rank_point AS rankPoint
            FROM players WHERE id = ?
        `).get(node.playerId)
        const ticket = database.prepare(`
            SELECT amount FROM players_items WHERE player_id = ? AND id = ?
        `).get(node.playerId, ticketQuest.itemId)?.amount ?? 0
        const activeQuests = database.prepare(`
            SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?
        `).get(node.playerId).count
        return { ...player, ticket, activeQuests }
    }, { readonly: true })
}

async function createRoom(harness, host, quest, apiCount) {
    const response = await harness.gamePost(host.url, `${apiPrefix}/create_room`, {
        viewer_id: host.viewerId,
        api_count: apiCount,
        category: quest.category,
        quest_id: quest.questId,
        party_id: 1,
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.data.room_number
}

async function searchRoom(harness, node, roomNumber, headers = defaultCompatibilityHeaders) {
    return harness.gamePost(node.url, `${apiPrefix}/search_room`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
    }, headers)
}

async function prepareRoom(harness, node, roomNumber, quest) {
    return harness.gamePost(node.url, `${apiPrefix}/prepare`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
        category: quest.category,
        quest_id: quest.questId,
    })
}

async function selectRoom(harness, node, roomNumber, quest) {
    return harness.gamePost(node.url, `${apiPrefix}/select_room`, {
        viewer_id: node.viewerId,
        api_count: 1,
        room_number: roomNumber,
        category: quest.category,
        quest_id: quest.questId,
        party_id: 1,
        accepted_type: 0,
    })
}

async function disbandRoom(harness, host, roomNumber) {
    const response = await harness.gamePost(host.url, `${apiPrefix}/disband_room`, {
        viewer_id: host.viewerId,
        api_count: 1,
        room_number: roomNumber,
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
}

async function enterRoom(harness, node, roomNumber, quest, endpoint, suffix) {
    const connectionId = `${node.dataKey}-${suffix}`
    const peer = await harness.openTcp(`${connectionId}-lobby`, endpoint.host, endpoint.port, {
        socklet: "cooperation_room",
        room_number: roomNumber,
        viewerId: node.viewerId,
        connection_id: connectionId,
        questCategory: quest.category,
        questId: quest.questId,
    })
    await peer.waitFor(message => message[0] === 0 && message[1] === connectionId)
    peer.send([0, [0, { party: roomParty(), currentPartyId: 1 }]])
    await peer.waitFor(message => message[0] === 1 && message[1]?.[0] === 0)
    return { peer, connectionId, endpoint }
}

async function openRoomParty(harness, nodes, quest, suffix, admissionRoute = "select") {
    const roomNumber = await createRoom(harness, nodes[0], quest, suffix.length)
    const lobby = []
    for (const [index, node] of nodes.entries()) {
        if (index > 0 && admissionRoute === "select") {
            const searched = await searchRoom(harness, node, roomNumber)
            assert.equal(searched.body.data.room_exists, true)
        }
        const admitted = admissionRoute === "prepare"
            ? await prepareRoom(harness, node, roomNumber, quest)
            : await selectRoom(harness, node, roomNumber, quest)
        const endpoint = preparedTcpEndpoint(admitted, roomNumber)
        lobby.push(await enterRoom(harness, node, roomNumber, quest, endpoint, suffix))
    }
    nodes.slice(1).forEach((_node, index) => lobby[index + 1].peer.send([0, [3, [1]]]))
    lobby[0].peer.send([0, [6]])
    await Promise.all(lobby.map(({ peer }) => (
        peer.waitFor(message => message[0] === 1 && message[1]?.[0] === 5)
    )))
    return { roomNumber, lobby }
}

async function startPlayers(harness, nodes, roomNumber, quest, label) {
    const playIds = new Map()
    for (const node of nodes) {
        const playId = `${label}-${node.dataKey}`
        const response = await harness.gamePost(
            node.url,
            `${apiPrefix}/start`,
            startPayload(node, roomNumber, quest, playId),
        )
        assert.equal(response.status, 200, JSON.stringify(response.body))
        playIds.set(node.dataKey, playId)
    }
    return playIds
}

async function openBattlePeers(harness, lobby, roomNumber, suffix) {
    const battle = []
    for (const member of lobby) {
        const peer = await harness.openTcp(
            `${member.connectionId}-${suffix}`,
            member.endpoint.host,
            member.endpoint.port,
            {
                socklet: "cooperation_battle",
                room_number: roomNumber,
                connection_id: member.connectionId,
            },
        )
        await peer.waitFor(message => message[0] === 0 && message[1] === roomNumber)
        battle.push(peer)
    }
    return battle
}

async function completeScene(peers) {
    peers.forEach(peer => peer.send([0, [0]]))
    await Promise.all(peers.map(peer => (
        peer.waitFor(message => message[0] === 1 && message[1]?.[0] === 1)
    )))
}

async function leaveLobbyForBattle(lobby) {
    lobby.forEach(({ peer }) => peer.send([0, [1]]))
    await Promise.all(lobby.map(({ peer }) => peer.closedPromise))
}

test("three compiled CN processes share trusted Hub state while keeping local settlement", {
    timeout: 210_000,
    skip: process.platform === "win32" ? "process signal coverage is POSIX-only" : false,
}, async t => {
    const harness = new MultiHubProcessHarness()
    t.after(() => harness.cleanup())
    harness.installRuntimeTables()
    const credentialB = harness.createCredential("process-client-b")
    const credentialC = harness.createCredential("process-client-c")
    const [hostHttp, hubPort, tcpPort, clientBHttp, clientCHttp] = await reserveLoopbackPorts(5)

    const host = {
        dataKey: "host",
        url: `http://127.0.0.1:${hostHttp}`,
    }
    const clientB = {
        dataKey: "client-b",
        url: `http://127.0.0.1:${clientBHttp}`,
    }
    const clientC = {
        dataKey: "client-c",
        url: `http://127.0.0.1:${clientCHttp}`,
    }

    const hostRuntime = harness.spawnRuntime("host", {
        DATA_DIR: harness.dataDir(host.dataKey),
        CN_LISTEN_PORT: String(hostHttp),
        MULTI_MODE: "host",
        MULTI_HUB_HOST: "127.0.0.1",
        MULTI_HUB_PORT: String(hubPort),
        SESSION_HOST: "127.0.0.1",
        SESSION_PUBLIC_HOST: "127.0.0.1",
        SESSION_PORT: String(tcpPort),
    }, [hostHttp, hubPort, tcpPort])
    const spawnClient = (label, node, port, token) => harness.spawnRuntime(label, {
        DATA_DIR: harness.dataDir(node.dataKey),
        CN_LISTEN_PORT: String(port),
        MULTI_MODE: "client",
        MULTI_HUB_URL: `http://127.0.0.1:${hubPort}/`,
        MULTI_HUB_TOKEN: token,
    }, [port])
    const clientBRuntime = spawnClient("client-b", clientB, clientBHttp, credentialB.token)
    let clientCRuntime = spawnClient("client-c", clientC, clientCHttp, credentialC.token)

    const initialHealth = await Promise.all([
        harness.waitForHealth(host.url, hostRuntime),
        harness.waitForHealth(clientB.url, clientBRuntime),
        harness.waitForHealth(clientC.url, clientCRuntime),
    ])
    assert.equal(initialHealth[0].multiplayer.mode, "host")
    assert.equal(initialHealth[1].multiplayer.state, "degraded")
    assert.equal(initialHealth[2].multiplayer.state, "degraded")

    await signUp(harness, host, 10101)
    await signUp(harness, clientB, 20202)
    await signUp(harness, clientC, 30303)
    await Promise.all([host, clientB, clientC].map(node => setPlayerField(
        harness,
        node,
        "stamina",
        100,
    )))
    await Promise.all([host, clientB, clientC].map(node => (
        setItem(harness, node, ticketQuest.itemId, 1)
    )))

    await setTime(harness, host, "2024-08-14T02:00:00.000Z")
    await setTime(harness, clientB, "2024-08-14T18:00:00.000Z")
    await setTime(harness, clientC, "2024-08-14T12:00:00.000Z")

    const timedRoom = await createRoom(harness, host, timedQuest, 10)
    const inside = await searchRoom(harness, clientB, timedRoom)
    assert.equal(inside.body.data.room_exists, true)

    const incompatible = await searchRoom(harness, clientC, timedRoom, {
        APP_VER: "9.9.9",
        RES_VER: defaultCompatibilityHeaders.RES_VER,
    })
    assert.equal(incompatible.body.data_headers.result_code, 4020)
    assert.equal(incompatible.body.data_headers.asset_update, false)
    for (const node of [clientB, clientC]) {
        const registeredStatus = await harness.json(node.url, "/api/server/status")
        assert.equal(registeredStatus.status, 200)
        assert.equal(registeredStatus.body.multiplayer.state, "ready")
    }

    await setTime(harness, clientB, "2024-08-16T00:00:00.000Z")
    const outside = await searchRoom(harness, clientB, timedRoom)
    assert.equal(outside.body.data_headers.result_code, 4020)
    const roomStillExists = await searchRoom(harness, host, timedRoom)
    assert.equal(roomStillExists.body.data.room_exists, true)
    await setTime(harness, clientB, "2024-08-14T18:00:00.000Z")

    const normalPrepared = await prepareRoom(harness, clientB, timedRoom, timedQuest)
    const hostEndpoint = preparedTcpEndpoint(normalPrepared, timedRoom)

    const originalClientCViewer = clientC.viewerId
    harness.withDatabase(clientC.dataKey, database => {
        database.prepare("UPDATE sessions SET token = ? WHERE token = ?")
            .run(String(host.viewerId), String(originalClientCViewer))
    })
    clientC.viewerId = host.viewerId
    const conflictSearch = await searchRoom(harness, clientC, timedRoom)
    assert.equal(conflictSearch.body.data_headers.result_code, 4020)
    const conflictPrepare = await prepareRoom(harness, clientC, timedRoom, timedQuest)
    assert.equal(conflictPrepare.body.data_headers.result_code, 4507)
    const denied = await harness.openTcp(
        "viewer-conflict",
        hostEndpoint.host,
        hostEndpoint.port,
        {
            socklet: "cooperation_room",
            room_number: timedRoom,
            viewerId: clientC.viewerId,
            connection_id: "viewer-conflict",
            questCategory: timedQuest.category,
            questId: timedQuest.questId,
        },
    )
    await denied.waitFor(message => message[0] === 3 && message[1] === "HANDSHAKE_DENIED")
    const unaffected = await searchRoom(harness, clientB, timedRoom)
    assert.equal(unaffected.body.data.room_exists, true)
    harness.withDatabase(clientC.dataKey, database => {
        database.prepare("UPDATE sessions SET token = ? WHERE token = ?")
            .run(String(originalClientCViewer), String(host.viewerId))
    })
    clientC.viewerId = originalClientCViewer
    await disbandRoom(harness, host, timedRoom)

    const ticketParty = await openRoomParty(
        harness,
        [host, clientB],
        ticketQuest,
        "ticket",
        "prepare",
    )
    const beforeTicket = new Map([host, clientB].map(node => [node.dataKey, playerState(harness, node)]))
    const ticketPlayIds = await startPlayers(
        harness,
        [host, clientB],
        ticketParty.roomNumber,
        ticketQuest,
        "ticket",
    )
    const hostTicketStarted = playerState(harness, host)
    const guestTicketStarted = playerState(harness, clientB)
    assert.ok(hostTicketStarted.stamina < beforeTicket.get(host.dataKey).stamina)
    assert.equal(hostTicketStarted.ticket, 0)
    assert.equal(guestTicketStarted.stamina, beforeTicket.get(clientB.dataKey).stamina)
    assert.equal(guestTicketStarted.ticket, 1)
    for (const node of [clientB, host]) {
        const aborted = await harness.gamePost(node.url, `${apiPrefix}/abort`, {
            viewer_id: node.viewerId,
            api_count: 1,
            quest_id: ticketQuest.questId,
            category: ticketQuest.category,
            room_number: ticketParty.roomNumber,
            play_id: ticketPlayIds.get(node.dataKey),
        })
        assert.equal(aborted.status, 200, JSON.stringify(aborted.body))
    }
    ticketParty.lobby.forEach(({ peer }) => peer.close())

    await Promise.all([host, clientB, clientC].map(node => setPlayerField(
        harness,
        node,
        "stamina",
        100,
    )))
    const beforeBoss = new Map([host, clientB, clientC].map(node => (
        [node.dataKey, playerState(harness, node)]
    )))
    const bossParty = await openRoomParty(
        harness,
        [host, clientB, clientC],
        bothBossQuest,
        "both-boss",
    )
    const bossPlayIds = await startPlayers(
        harness,
        [host, clientB, clientC],
        bossParty.roomNumber,
        bothBossQuest,
        "both-boss",
    )
    assert.ok(playerState(harness, host).stamina < 100)
    assert.equal(playerState(harness, clientB).stamina, 100)
    assert.equal(playerState(harness, clientC).stamina, 100)

    const battlePeers = await openBattlePeers(
        harness,
        bossParty.lobby,
        bossParty.roomNumber,
        "battle",
    )
    await leaveLobbyForBattle(bossParty.lobby)
    await completeScene(battlePeers)
    const earlyFinish = await harness.gamePost(
        host.url,
        `${apiPrefix}/finish`,
        finishPayload(
            host,
            bossParty.roomNumber,
            bothBossQuest,
            bossPlayIds.get(host.dataKey),
        ),
    )
    assert.equal(earlyFinish.status, 400)
    assert.equal(playerState(harness, host).activeQuests, 1)

    battlePeers.forEach(peer => peer.send([0, [1]]))
    await completeScene(battlePeers)
    battlePeers.forEach(peer => peer.send([0, [2]]))
    await Promise.all(battlePeers.map(peer => (
        peer.waitFor(message => message[0] === 1 && message[1]?.[0] === 2)
    )))

    const finishNode = async node => {
        const response = await harness.gamePost(
            node.url,
            `${apiPrefix}/finish`,
            finishPayload(
                node,
                bossParty.roomNumber,
                bothBossQuest,
                bossPlayIds.get(node.dataKey),
            ),
        )
        assert.equal(response.status, 200, JSON.stringify(response.body))
    }
    await finishNode(host)
    assert.equal(playerState(harness, clientB).activeQuests, 1)
    assert.equal(playerState(harness, clientC).activeQuests, 1)
    await finishNode(clientB)

    bossParty.lobby[2].peer.close()
    battlePeers[2].close()
    await clientCRuntime.stop()
    clientCRuntime = spawnClient("client-c-rotated", clientC, clientCHttp, credentialC.token)
    await harness.waitForHealth(clientC.url, clientCRuntime)
    const loaded = await harness.gamePost(clientC.url, "/api/index.php/load", {
        viewer_id: clientC.viewerId,
        keychain: clientC.viewerId,
        device_id: 30303,
        device_token: "rotated-process-session",
        graphics_device_name: "fixture",
        platform_os_version: "fixture",
        storage_directory_path: "/fixture",
    }, { RES_VER: defaultCompatibilityHeaders.RES_VER })
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body))
    assert.deepEqual(loaded.body.data.unfinished_multi_quest_list, [])
    assert.equal(playerState(harness, clientC).activeQuests, 0)

    for (const node of [host, clientB]) {
        const after = playerState(harness, node)
        const before = beforeBoss.get(node.dataKey)
        assert.equal(after.activeQuests, 0)
        assert.equal(after.rankPoint, before.rankPoint + 399)
        assert.ok(after.freeMana >= before.freeMana + 1290)
    }
    const clientCAfterRestart = playerState(harness, clientC)
    const clientCBeforeBoss = beforeBoss.get(clientC.dataKey)
    assert.equal(clientCAfterRestart.rankPoint, clientCBeforeBoss.rankPoint)
    assert.equal(clientCAfterRestart.freeMana, clientCBeforeBoss.freeMana)

    bossParty.lobby.forEach(({ peer }) => peer.close())
    battlePeers.forEach(peer => peer.close())
    const degradedParty = await openRoomParty(
        harness,
        [host, clientB],
        bothBossQuest,
        "hub-stop",
    )
    const degradedPlayIds = await startPlayers(
        harness,
        [host, clientB],
        degradedParty.roomNumber,
        bothBossQuest,
        "hub-stop",
    )
    assert.equal(playerState(harness, clientB).activeQuests, 1)
    await hostRuntime.stop()

    const unavailable = await searchRoom(harness, clientB, degradedParty.roomNumber)
    assert.equal(unavailable.body.data_headers.result_code, 4020)
    const clientStatus = await harness.json(clientB.url, "/api/server/status")
    assert.equal(clientStatus.status, 200)
    assert.equal(clientStatus.body.multiplayer.state, "degraded")
    const degradedHealth = await fetch(`${clientB.url}/healthz`)
    assert.equal((await degradedHealth.json()).multiplayer.state, "degraded")

    const retained = await harness.gamePost(clientB.url, "/api/index.php/load", {
        viewer_id: clientB.viewerId,
        keychain: clientB.viewerId,
        device_id: 20202,
        device_token: "hub-stop-process",
        graphics_device_name: "fixture",
        platform_os_version: "fixture",
        storage_directory_path: "/fixture",
    }, { RES_VER: defaultCompatibilityHeaders.RES_VER })
    assert.equal(retained.status, 200, JSON.stringify(retained.body))
    assert.deepEqual(retained.body.data.unfinished_multi_quest_list, [])
    assert.equal(playerState(harness, clientB).activeQuests, 0)

    const guestAbort = await harness.gamePost(clientB.url, `${apiPrefix}/abort`, {
        viewer_id: clientB.viewerId,
        api_count: 1,
        quest_id: bothBossQuest.questId,
        category: bothBossQuest.category,
        room_number: degradedParty.roomNumber,
        play_id: degradedPlayIds.get(clientB.dataKey),
    })
    assert.equal(guestAbort.status, 400, JSON.stringify(guestAbort.body))
    assert.equal(playerState(harness, clientB).activeQuests, 0)
})
