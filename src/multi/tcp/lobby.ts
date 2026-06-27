import * as net from "net"
import { sessionManager, SessionClient } from "../state/SessionManager"
import { getRoom, updateRoomState } from "../room/manager"
import { NpcMateProvider } from "../npc/controller"
import { buildRealParty } from "./handshake"
import { PartyCategory } from "../../data/types"
import { getPlayerPartyGroupListSync } from "../../data/wdfpData"

const NPC_JOIN_DELAY_MS = parseInt(process.env.NPC_JOIN_DELAY_MS || "2000")
const NPC_READY_DELAY_MS = parseInt(process.env.NPC_READY_DELAY_MS || "500")

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
    return mates.filter(m => (m.viewerId ?? 0) < 900000000).length
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
}

export function notifyRoomDisbanded(roomNumber: string): void {
    sessionManager.broadcastToRoom(roomNumber, [1, [6, "multibattle_room_dismissed"]])
}

async function handleEnterComs(client: SessionClient, coms: { name: string }[]): Promise<void> {
    const room = getRoom(client.roomNumber)
    if (room) room.is_npc_mode = true

    const hostMate = client.yourself ?? client.mates[0]
    if (!hostMate) return

    const realMates = client.mates.filter(m => (m.viewerId ?? 0) < 900000000)
    const needNPCs = 3 - realMates.length
    if (needNPCs <= 0) {
        console.log(`[LOBBY] EnterComs: room full (${realMates.length} players), skip NPCs`)
        return
    }

    const npcProvider = new NpcMateProvider()
    const recruitResult = await npcProvider.onRecruit(client.roomNumber, String(room?.host_viewer_id ?? 0))

    // Fetch NPC party data from player's DB (uses real equipment/character IDs)
    const npcParties: any[] = []
    if (client.playerId) {
        try {
            for (const category of [PartyCategory.NORMAL, PartyCategory.EVENT]) {
                const groups = getPlayerPartyGroupListSync(client.playerId, category)
                for (const g of Object.values(groups)) {
                    for (const party of Object.values(g.list)) {
                        if (party.name && party.name.includes("NPC")) {
                            npcParties.push(buildRealParty(client.playerId, party))
                        }
                    }
                }
            }
        } catch (e) { }
    }

    const npcMates: any[] = []
    for (let i = 0; i < needNPCs; i++) {
        const recruited = recruitResult.recruitedMates[i] ?? null
        const comId = recruited?.com_id ?? (i + 1)
        const viewerId = recruited?.viewer_id ?? (900000000 + i + 1)
        const party = npcParties[i] ?? npcParties[0] ?? hostMate.party

        npcMates.push({
            viewerId: viewerId,
            comId: comId,
            name: coms[i]?.name ?? `NPC${comId}`,
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

    client.mates = [...realMates, ...npcMates]

    const hostClient = findHostClient(client.roomNumber)
    if (hostClient) hostClient.mates = client.mates

    if (room) {
        for (const recruited of recruitResult.recruitedMates) {
            if (!room.mates.find(m => m.viewer_id === recruited.viewer_id)) {
                room.mates.push({ viewer_id: recruited.viewer_id, com_id: recruited.com_id })
            }
        }
    }

    console.log(`[LOBBY] EnterComs: room=${client.roomNumber} real=${realMates.length} npc=${npcMates.length} total=${client.mates.length}`)

    setTimeout(() => {
        sessionManager.broadcastToRoom(client.roomNumber, [1, [1, client.mates]])
        updateRoomState(client.roomNumber, 3)
    }, NPC_JOIN_DELAY_MS)

    setTimeout(() => {
        for (const npc of npcMates) {
            npc.state = [1]
            sessionManager.broadcastToRoom(client.roomNumber, [1, [2, npc.connectionId, [1]]])
        }
        if (realMates.length === 1) checkHostAutoReady(client.roomNumber)
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
                    if (c && c !== client && !c.isBattle && c.mates[0]) {
                        const gm = c.mates.find((m: { viewerId: number }) => m.viewerId === c.viewerId)
                        if (gm) client.mates.push(gm)
                    }
                }
            }
        }
        if (room) room.mates = client.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))
        if (client.mates.length > 1) {
            sessionManager.broadcastToRoom(client.roomNumber, [1, [1, client.mates]], `${client.viewerId}@${client.roomNumber}`)
        }
        if (room?.is_npc_mode && countRealPlayers(client.mates) < 3) {
            setTimeout(() => handleEnterComs(client, [{ name: "开心超人" }, { name: "名字真难取" }]), 500)
        }
    } else {
        if (hostClient && client.yourself) {
            hostClient.mates.push(client.yourself)
            while (hostClient.mates.length > 3) {
                const npcIdx = hostClient.mates.findIndex(m => (m.viewerId ?? 0) >= 900000000)
                if (npcIdx >= 0) hostClient.mates.splice(npcIdx, 1)
                else break
            }
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
    sessionManager.broadcastToRoom(client.roomNumber, [1, [1, hostClient?.mates ?? []]])
    sessionManager.removeClient(client)
    try { client.socket.destroy(); } catch (e) {}
    console.log(`[LOBBY] client ${client.viewerId} left room ${client.roomNumber}`)
}

function handleChangeParty(_socket: net.Socket, client: SessionClient, data: any[]): void {
    const pd = data[1]
    if (pd?.party && client.yourself) {
        client.yourself.party = pd.party
        if (pd.currentPartyId !== undefined) {
            client.yourself.currentPartyId = pd.currentPartyId
        }
    }
    const mate = client.mates.find(m => m.viewerId === client.viewerId)
    if (mate) {
        if (client.playerId && pd.currentPartyId !== undefined) { try { const up = require("../../data/wdfpData").updatePlayerSync; up({ id: client.playerId, partySlot: pd.currentPartyId }); } catch(e) {} }
        const room = getRoom(client.roomNumber); if (room) { room.host_party_id = pd.currentPartyId; }
        sessionManager.broadcastToRoom(client.roomNumber, [1, [1, client.mates]])
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
    sessionManager.sendJson(socket, [1, [10, client.connectionId]])
}

function handleStartBattle(_socket: net.Socket, client: SessionClient, _data: any[]): void {
    if ((sessionManager as any).battleExpectedCount?.has?.(client.roomNumber)) return

    const expectedCount = countRealPlayers(client.mates)
    sessionManager.setBattleExpectedCount(client.roomNumber, expectedCount)
    updateRoomState(client.roomNumber, 4)

    const members = [...client.mates]
    sessionManager.broadcastToRoom(client.roomNumber, [1, [5, members]])
    console.log(`[LOBBY] StartBattle: room=${client.roomNumber} mates=${client.mates.length} expected=${expectedCount}`)
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
        case 6: handleStartBattle(socket, client, notifyData); break
        case 10: handleEnterComs(client, notifyData[1] as any[]); break
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
