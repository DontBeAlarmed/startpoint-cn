import * as net from "net"
import { sessionManager, SessionClient } from "../state/SessionManager"
import { disbandRoom, getRoom, removeRoomMember, updateRoomState } from "../room/manager"
import { NpcMateProvider } from "../npc/controller"
import { ensureNpcRoster, getActiveNpcRoster } from "../npc/nickname-pool"
import type { MultiRoom } from "../../lib/types"
import {
    getLobbyLifecycleGuard,
    LobbyLifecycleGuard,
    scheduleLobbyTask,
} from "./lobby-lifecycle"
import { updatePlayerSnapshotParty } from "../snapshot/player-snapshot"

const NPC_JOIN_DELAY_MS = parseInt(process.env.NPC_JOIN_DELAY_MS || "2000")
const NPC_READY_DELAY_MS = parseInt(process.env.NPC_READY_DELAY_MS || "500")

interface RoomRecruitmentState {
    nextRequestId: number
    committedRequestId: number
    revision: number
}

const roomRecruitmentStates = new WeakMap<MultiRoom, RoomRecruitmentState>()

function getRoomRecruitmentState(room: MultiRoom): RoomRecruitmentState {
    let state = roomRecruitmentStates.get(room)
    if (!state) {
        state = { nextRequestId: 0, committedRequestId: 0, revision: 0 }
        roomRecruitmentStates.set(room, state)
    }
    return state
}

function beginRecruitmentRequest(room: MultiRoom): number {
    const state = getRoomRecruitmentState(room)
    state.nextRequestId++
    return state.nextRequestId
}

function commitRecruitmentRequest(room: MultiRoom, requestId: number): number | null {
    const state = getRoomRecruitmentState(room)
    if (requestId < state.committedRequestId) return null
    state.committedRequestId = requestId
    state.revision++
    return state.revision
}

function isCommittedRecruitment(roomNumber: string, room: MultiRoom, revision: number): boolean {
    return getRoom(roomNumber) === room && getRoomRecruitmentState(room).revision === revision
}

function findClientBySocket(socket: net.Socket): SessionClient | undefined {
    const clientsMap = (sessionManager as any).clients as Map<string, SessionClient> | undefined
    if (!clientsMap) return undefined
    for (const client of clientsMap.values()) {
        if (client.socket === socket) return client
    }
    return undefined
}

function findHostClient(roomNumber: string): SessionClient | undefined {
    const room = getRoom(roomNumber)
    if (!room) return undefined
    const clientsMap = (sessionManager as any).clients as Map<string, SessionClient> | undefined
    if (!clientsMap) return undefined
    for (const client of clientsMap.values()) {
        if (client.viewerId === room.host_viewer_id && client.roomNumber === roomNumber && !client.isBattle) {
            return client
        }
    }
    return undefined
}

function countRealPlayers(mates: any[]): number {
    return mates.filter(m => !m.comId).length  // real player has no comId
}

function selectRealMates(mates: any[], hostViewerId: number): any[] {
    const seenViewerIds = new Set<number>()
    let hostMate: any | undefined
    const guestMates: any[] = []
    for (const mate of mates) {
        if (mate.comId || seenViewerIds.has(mate.viewerId)) continue
        seenViewerIds.add(mate.viewerId)
        if (mate.viewerId === hostViewerId) hostMate = mate
        else guestMates.push(mate)
    }
    return (hostMate ? [hostMate, ...guestMates] : guestMates).slice(0, 3)
}

function getConnectedRealMates(client: SessionClient, room: MultiRoom): any[] {
    const connectedMates = sessionManager.getClientsInRoom(client.roomNumber)
        .map(connectedClient => connectedClient.yourself)
        .filter(mate => mate !== undefined)
    return selectRealMates([...client.mates, ...connectedMates], room.host_viewer_id)
}

function limitLobbyMates(mates: any[], hostViewerId: number): any[] {
    const realMates = selectRealMates(mates, hostViewerId)
    const npcSlots = 3 - realMates.length
    const npcMates = npcSlots > 0
        ? mates.filter(mate => !!mate.comId).slice(-npcSlots)
        : []
    return [...realMates, ...npcMates]
}

function commitRoomMates(client: SessionClient, room: MultiRoom, mates: any[]): void {
    client.mates = mates
    const hostClient = findHostClient(client.roomNumber)
    if (hostClient) hostClient.mates = client.mates
    room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
}

export function checkHostAutoReady(roomNumber: string): void {
    const room = getRoom(roomNumber)
    if (!room) return
    const hostClient = findHostClient(roomNumber)
    if (!hostClient) return
    const hostMate = hostClient.mates.find(m => m.viewerId === hostClient.viewerId)
    if (!hostMate) return

    const nonHostReady = hostClient.mates.every(m =>
        m.viewerId === hostClient.viewerId || m.state?.[0] === 1
    )
    if (nonHostReady && hostClient.mates.length > 1) {
        if (hostMate.state?.[0] !== 1) {
            hostMate.state = [1]
            sessionManager.broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [1]]])
            console.log(`[LOBBY] host auto-ready: room=${roomNumber}`)
        }
    } else {
        if (hostMate.state?.[0] === 1) {
            hostMate.state = [0]
            sessionManager.broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [0]]])
            console.log(`[LOBBY] host auto-ready cancelled: room=${roomNumber}`)
        }
    }
    checkAllReadyAndStart(roomNumber)
}

const autoStartingRooms = new Set<string>()

function checkAllReadyAndStart(roomNumber: string): void {
    if (autoStartingRooms.has(roomNumber)) return
    const hostClient = findHostClient(roomNumber)
    if (!hostClient) return
    const room = getRoom(roomNumber)
    if (!room) return

    // Guard: wait for all expected real players to return on rematch
    if (room.npc_count > 0) {
        const realPlayers = countRealPlayers(hostClient.mates)
        const expectedReal = 3 - room.npc_count
        if (realPlayers < expectedReal) return
    }
    if (hostClient.mates.length < 3) return

    const allReady = hostClient.mates.every(m => m.state?.[0] === 1)
    if (!allReady) return

    autoStartingRooms.add(roomNumber)
    console.log(`[LOBBY] all ready — StartRemainingTime float: room=${roomNumber}`)
    sessionManager.broadcastToRoom(roomNumber, [1, [10, 2]])
}

export function notifyRoomDisbanded(roomNumber: string): void {
    sessionManager.broadcastToRoom(roomNumber, [1, [6, "multibattle_room_dismissed"]])
}

async function handleEnterComs(
    client: SessionClient,
    lifecycle: LobbyLifecycleGuard = getLobbyLifecycleGuard(),
): Promise<void> {
    const room = getRoom(client.roomNumber)
    if (!room) return
    room.is_npc_mode = true
    const requestId = beginRecruitmentRequest(room)

    const hostMate = client.yourself ?? client.mates[0]
    if (!hostMate) return

    const initialRealMates = getConnectedRealMates(client, room)

    // Assign the room roster synchronously so concurrent EnterComs calls share one binding.
    if (room.npc_count <= 0) {
        room.npc_count = Math.max(0, 3 - initialRealMates.length)
    }
    ensureNpcRoster(room, room.npc_count)

    const initialActiveCount = Math.max(0, Math.min(room.npc_count, 3 - initialRealMates.length))
    if (initialActiveCount <= 0) {
        commitRecruitmentRequest(room, requestId)
        commitRoomMates(client, room, initialRealMates)
        console.log(`[LOBBY] EnterComs: room full (${initialRealMates.length} players), skip NPCs`)
        return
    }

    const npcProvider = new NpcMateProvider()
    const recruitResult = await npcProvider.onRecruit(client.roomNumber, String(room?.host_viewer_id ?? 0))
    if (!lifecycle.isActive() || getRoom(client.roomNumber) !== room) return
    if (requestId < getRoomRecruitmentState(room).committedRequestId) return

    // Real players may enter while the provider is pending. Rebuild from current room state.
    const currentRealMates = getConnectedRealMates(client, room)
    const activeCount = Math.max(0, Math.min(room.npc_count, 3 - currentRealMates.length))
    const assignments = getActiveNpcRoster(room, activeCount)

    const npcMates: any[] = []
    const recruitedByComId = new Map(recruitResult.recruitedMates.map(mate => [mate.com_id, mate]))
    for (let i = 0; i < assignments.length; i++) {
        const assignment = assignments[i]
        const recruited = recruitedByComId.get(assignment.com_id)
        const comId = assignment.com_id
        const viewerId = recruited?.viewer_id ?? (900000000 + comId)
        const party = client.npcPartySnapshots[assignment.com_id - 1]
            ?? client.npcPartySnapshots[0]
            ?? hostMate.party

        npcMates.push({
            viewerId: viewerId,
            comId: comId,
            name: assignment.name,
            rank: hostMate.rank,
            degreeId: hostMate.degreeId,
            playerRoleKind: 99,
            party,
            connectionId: `${client.roomNumber}-npc-${comId}`,
            autoplayMode: false,
            autoskillMode: 1,
            autoSpeedLevel: 1,
            autoStart: false,
            skillAbilityBehaviorMode: 1,
            dashBehaviorMode: 1,
            allowHealFromOtherPlayers: true,
            state: [0],
            entryTime: Date.now(),
            isNewbie: false,
            isHost: false,
        })
    }

    const committedRevision = commitRecruitmentRequest(room, requestId)
    if (committedRevision === null) return
    commitRoomMates(client, room, [...currentRealMates, ...npcMates])

    console.log(`[LOBBY] EnterComs: room=${client.roomNumber} real=${currentRealMates.length} npc=${npcMates.length} total=${client.mates.length}`)

    if (npcMates.length === 0) return

    scheduleLobbyTask(() => {
        try {
            if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
            // Send Mates only to triggering client — others get theirs via handleEnter
            sessionManager.sendJson(client.socket, [1, [1, client.mates]])
        } catch (e) { console.error("[LOBBY] EnterComs send-mates error", e) }
    }, NPC_JOIN_DELAY_MS)

    scheduleLobbyTask(() => {
        try {
            if (!isCommittedRecruitment(client.roomNumber, room, committedRevision)) return
            const currentHostClient = findHostClient(client.roomNumber)
            if (!currentHostClient) return
            const recruitedNpcKeys = new Set(npcMates.map(npc =>
                `${npc.comId}:${npc.viewerId}:${npc.connectionId}`
            ))
            const currentNpcMates = currentHostClient.mates.filter(npc =>
                recruitedNpcKeys.has(`${npc.comId}:${npc.viewerId}:${npc.connectionId}`)
            )
            for (const npc of currentNpcMates) {
                npc.state = [1]
                sessionManager.broadcastToRoom(client.roomNumber, [1, [2, npc.connectionId, [1]]])
            }
            if (countRealPlayers(currentHostClient.mates) === 1) checkHostAutoReady(client.roomNumber)
        } catch (e) { console.error("[LOBBY] EnterComs npc-ready error", e) }
    }, NPC_JOIN_DELAY_MS + NPC_READY_DELAY_MS)
}

function handleEnter(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const ed = data[1]
    if (!ed?.party || !client.yourself) return

    client.yourself.party = ed.party
    if (ed.autoplayMode !== undefined) client.yourself.autoplayMode = ed.autoplayMode;
    if (ed.autoskillMode !== undefined) client.yourself.autoskillMode = ed.autoskillMode;
    if (ed.autoSpeedLevel !== undefined) client.yourself.autoSpeedLevel = ed.autoSpeedLevel;
    if (ed.autoStart !== undefined) client.yourself.autoStart = ed.autoStart;
    if (ed.skillAbilityBehaviorMode !== undefined) client.yourself.skillAbilityBehaviorMode = ed.skillAbilityBehaviorMode;
    if (ed.dashBehaviorMode !== undefined) client.yourself.dashBehaviorMode = ed.dashBehaviorMode;
    if (ed.allowHealFromOtherPlayers !== undefined) client.yourself.allowHealFromOtherPlayers = ed.allowHealFromOtherPlayers;
    client.enterData = ed

    const room = getRoom(client.roomNumber)
    const isHost = room && client.viewerId === room.host_viewer_id

    if (isHost) {
        updateRoomState(client.roomNumber, 1)
    }

    const hostClient = findHostClient(client.roomNumber)

    // Guest entered before host (or host connected but hasn't entered) → wait with Welcome
    if (!isHost && (!hostClient || !hostClient.mates[0])) {
        client.mates = [client.yourself!]
        sessionManager.sendJson(client.socket, [1, [0, client.yourself, [client.yourself]]])
        console.log(`[LOBBY] guest ${client.viewerId} entered alone, waiting for host in room ${client.roomNumber}`)
        return
    }

    if (isHost) {
        client.mates = [client.yourself!]
        const set = (sessionManager as any).roomClients?.get?.(client.roomNumber) as Set<string> | undefined
        if (set) {
            const clientsMap = (sessionManager as any).clients as Map<string, SessionClient> | undefined
            if (clientsMap) {
                for (const addr of set) {
                    const c = clientsMap.get(addr)
                    if (c && c !== client && !c.isBattle && c.yourself) {
                        client.mates.push(c.yourself)
                    }
                }
            }
        }
        if (room) client.mates = selectRealMates(client.mates, room.host_viewer_id)
        if (room) room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
        if (client.mates.length > 1) {
            sessionManager.broadcastToRoom(client.roomNumber, [1, [1, client.mates]], `${client.viewerId}@${client.roomNumber}`)
        }
        if (room && room.npc_count > 0 && countRealPlayers(client.mates) < 3) {
            scheduleLobbyTask(lifecycle => { handleEnterComs(client, lifecycle).catch(e => console.error("[LOBBY] EnterComs (timer) error", e)); }, 500)
        }
    } else {
        if (hostClient && client.yourself) {
            hostClient.mates = limitLobbyMates(
                [...hostClient.mates, client.yourself],
                room?.host_viewer_id ?? hostClient.viewerId,
            )
            client.mates = [...hostClient.mates]
        } else {
            client.mates = [client.yourself!]
        }
        if (room) room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
    }

    const yourself = client.yourself
    if (yourself) {
        sessionManager.sendJson(client.socket, [1, [0, yourself, [yourself]]])
    }

    if (!isHost) {
        const mates = hostClient?.mates ?? client.mates
        sessionManager.broadcastToRoom(client.roomNumber, [1, [1, mates]], undefined)
    }

    console.log(`[LOBBY] ${isHost ? "host" : "guest"} ${client.viewerId} entered room ${client.roomNumber}`)
}

function handleBye(_socket: net.Socket, client: SessionClient, _data: any[]): void {
    const room = getRoom(client.roomNumber)
    const isHost = room?.host_viewer_id === client.viewerId
    if (isHost) {
        sessionManager.broadcastToRoom(client.roomNumber, [1, [6, "multibattle_room_dismissed"]])
    }
    const set = (sessionManager as any).roomClients?.get?.(client.roomNumber) as Set<string> | undefined
    if (set) {
        const clientsMap = (sessionManager as any).clients as Map<string, SessionClient> | undefined
        if (clientsMap) {
            for (const addr of set) {
                const c = clientsMap.get(addr)
                if (c && c !== client && !c.isBattle) {
                    c.mates = c.mates.filter(m => m.viewerId !== client.viewerId)
                }
            }
        }
    }
    const hostClient = findHostClient(client.roomNumber)
    removeRoomMember(client.roomNumber, client.viewerId)
    sessionManager.removeClient(client)
    if (isHost) disbandRoom(client.roomNumber)
    // Only refresh the mate list if the room still exists AND a *different* client is the host (i.e. a
    // guest left but the room lives on). If the room was disbanded (host left / went empty), the
    // [6, dismissed] broadcast already tore it down — pushing a stale/empty mate list here makes the
    // remaining client's refreshMates dereference undefined character-display data and crash (F1010).
    if (getRoom(client.roomNumber) && hostClient && hostClient !== client) {
        sessionManager.broadcastToRoom(client.roomNumber, [1, [1, hostClient.mates]])
    }
    try { client.socket.destroy(); } catch (e) {}
    console.log(`[LOBBY] client ${client.viewerId} left room ${client.roomNumber}`)
}

function handleChangeParty(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const pd = data[1]
    if (pd?.party && client.yourself) {
        if (client.snapshot) {
            client.snapshot = updatePlayerSnapshotParty(
                client.snapshot,
                pd.party,
                pd.currentPartyId ?? client.snapshot.currentPartyId,
            )
            client.yourself.party = client.snapshot.party
            client.yourself.currentPartyId = client.snapshot.currentPartyId
        } else {
            client.yourself.party = pd.party
            if (pd.currentPartyId !== undefined) {
                client.yourself.currentPartyId = pd.currentPartyId
            }
        }
    }
    const mate = client.mates.find(m => m.viewerId === client.viewerId)
    if (mate) {
        const room = getRoom(client.roomNumber); if (room) { room.host_party_id = pd.currentPartyId; }
        const hostClient = findHostClient(client.roomNumber)
        sessionManager.broadcastToRoom(client.roomNumber, [1, [1, hostClient?.mates ?? client.mates]])
    }
    console.log(`[LOBBY] client ${client.viewerId} changed party`)
}

function handleReady(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const readyState = Array.isArray(data[1]) ? data[1][0] : data[1]
    client.isReady = readyState === 1

    const mate = client.mates.find(m => m.viewerId === client.viewerId)
    if (mate) {
        mate.state = data[1] ?? [1]
        sessionManager.broadcastToRoom(client.roomNumber, [1, [2, mate.connectionId, mate.state]])
    }

    checkHostAutoReady(client.roomNumber)
    console.log(`[LOBBY] client ${client.viewerId} ready: ${client.isReady}`)
}

function handleHeartbeat(socket: net.Socket, client: SessionClient, _data: any[]): void {
    sessionManager.sendJson(socket, [1, [11, client.connectionId]])
}

function handleStartBattle(_socket: net.Socket, client: SessionClient, _data: any[]): void {
    const room = getRoom(client.roomNumber)
    if (!room || room.host_viewer_id !== client.viewerId || !client.participant) return
    if ((sessionManager as any).battleExpectedCount?.has?.(client.roomNumber)) return

    const realMembers = client.mates.filter(mate => !mate.comId)
    const clientsByViewerId = new Map(sessionManager.getClientsInRoom(client.roomNumber)
        .map(member => [member.viewerId, member]))
    sessionManager.setBattleParticipants(client.roomNumber, realMembers.flatMap(mate => {
        const member = clientsByViewerId.get(Number(mate.viewerId))
        if (!member?.participant) return []
        return [{
            connectionId: String(mate.connectionId ?? ""),
            participant: member.participant,
        }]
    }), client.participant)
    updateRoomState(client.roomNumber, 4)

    autoStartingRooms.delete(client.roomNumber)
    const members = [...client.mates]
    sessionManager.broadcastToRoom(client.roomNumber, [1, [5, members]])
    console.log(`[LOBBY] StartBattle: room=${client.roomNumber} mates=${client.mates.length} expected=${realMembers.length}`)
}

function handleNotify(socket: net.Socket, client: SessionClient, data: any[]): void {
    const notifyData = data[1]
    if (!Array.isArray(notifyData)) return
    const tag = notifyData[0] as number

    switch (tag) {
        case 0: handleEnter(socket, client, notifyData); break
        case 1: handleBye(socket, client, notifyData); break
        case 2: handleChangeParty(socket, client, notifyData); break
        case 3: handleReady(socket, client, notifyData); break
        case 4: handleHeartbeat(socket, client, notifyData); break
        case 5: case 7: case 8: case 9: break  // Suspend/ChangeAutoplay/ChangeAutoStart/Log — silently ignored
        case 6: handleStartBattle(socket, client, notifyData); break
        case 10: handleEnterComs(client).catch(e => console.error("[LOBBY] EnterComs error", e)); break
        default:
            console.log(`[LOBBY] unhandled Notify: ${tag}`)
    }
}

function handleBroadcast(_socket: net.Socket, client: SessionClient, data: any[]): void {
    sessionManager.broadcastToRoom(client.roomNumber, data)
}

function handleSend(_socket: net.Socket, _client: SessionClient, data: any[]): void {
    const targetViewerId = data[1] as number
    const roomNumber = _client.roomNumber
    const clientsMap = (sessionManager as any).clients as Map<string, SessionClient> | undefined
    if (!clientsMap) return
    for (const c of clientsMap.values()) {
        if (c.viewerId === targetViewerId && c.roomNumber === roomNumber) {
            sessionManager.sendJson(c.socket, data)
            return
        }
    }
}

export function handleMessage(socket: net.Socket, data: unknown): void {
    if (!Array.isArray(data)) return
    const tag = data[0] as number
    const client = findClientBySocket(socket)
    if (!client) {
        console.log(`[LOBBY] no client found for socket, dropping message tag=${tag}`)
        return
    }

    switch (tag) {
        case 0: handleNotify(socket, client, data); break
        case 1: handleBroadcast(socket, client, data); break
        case 2: handleSend(socket, client, data); break
        default:
            console.log(`[LOBBY] unhandled Client2Server: ${tag}`)
    }
}
