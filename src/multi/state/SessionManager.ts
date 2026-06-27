// Multi battle session manager
// Atomic indexing of room clients, battle clients and per-room state machines.
// Protocol arrays follow typepacker useEnumIndex=true format (see sessionServer.ts).

import * as net from "net"
import { Result, ClientState, BattleState } from "../types"
import { RoomStateMachine } from "./RoomStateMachine"
import { ClientStateMachine } from "./ClientStateMachine"

export interface SessionClient {
    socket: net.Socket
    viewerId: number
    roomNumber: string
    connectionId: string
    playerId: number | null
    isBattle: boolean
    isReady: boolean
    buffer: string
    mates: any[]
    enterData: any
    yourself?: any
    clientState: ClientStateMachine
    battleState: BattleState
}

export class SessionManager {
    private clients = new Map<string, SessionClient>()
    private roomClients = new Map<string, Set<string>>()
    private battleClients = new Map<string, Set<string>>()
    private cidToBattleClient = new Map<string, SessionClient>()
    private sceneReadyClients = new Map<string, Set<string>>()
    private battleExpectedCount = new Map<string, number>()
    private roomStates = new Map<string, RoomStateMachine>()

    private addr(viewerId: number, roomNumber: string): string {
        return `${viewerId}@${roomNumber}`
    }

    createClient(socket: net.Socket, viewerId: number, roomNumber: string, connectionId: string, playerId: number | null): SessionClient {
        return {
            socket,
            viewerId,
            roomNumber,
            connectionId,
            playerId,
            isBattle: false,
            isReady: false,
            buffer: "",
            mates: [],
            enterData: null,
            clientState: new ClientStateMachine(ClientState.Connecting),
            battleState: BattleState.Initializing,
        }
    }

    getClient(viewerId: number, roomNumber: string): SessionClient | undefined {
        return this.clients.get(this.addr(viewerId, roomNumber))
    }

    addClientToRoom(client: SessionClient): Result<void> {
        const addr = this.addr(client.viewerId, client.roomNumber)
        this.clients.set(addr, client)
        let set = this.roomClients.get(client.roomNumber)
        if (!set) {
            set = new Set()
            this.roomClients.set(client.roomNumber, set)
        }
        set.add(addr)
        return { ok: true, value: undefined }
    }

    removeClient(client: SessionClient): Result<void> {
        const addr = this.addr(client.viewerId, client.roomNumber)
        this.clients.delete(addr)

        if (client.isBattle) {
            const bSet = this.battleClients.get(client.roomNumber)
            if (bSet) {
                for (const cid of bSet) {
                    if (cid !== client.connectionId) {
                        const c = this.cidToBattleClient.get(cid)
                        if (c) this.sendJson(c.socket, [1, [0, client.connectionId]]) // BattleServerMessage.Leave(connectionId)
                    }
                }
            }
            this.battleClients.get(client.roomNumber)?.delete(client.connectionId)
            this.cidToBattleClient.delete(client.connectionId)
            this.sceneReadyClients.get(client.roomNumber)?.delete(client.connectionId)
            const exp = this.battleExpectedCount.get(client.roomNumber)
            if (exp && exp > 1) this.battleExpectedCount.set(client.roomNumber, exp - 1)
        }

        const set = this.roomClients.get(client.roomNumber)
        if (set) {
            set.delete(addr)
            if (set.size === 0) {
                this.roomClients.delete(client.roomNumber)
                // OLD: auto-disband empty non-battle rooms
                // But check if battle clients still exist first
                const bSet = this.battleClients.get(client.roomNumber)
                if (!bSet || bSet.size === 0) {
                    if (!client.isBattle) {
                        const { getRoom, disbandRoom } = require("../room/manager")
                        const room = getRoom(client.roomNumber)
                        if (room && room.raising_state !== 4) {
                            this.broadcastToRoom(client.roomNumber, [1, [6, "multibattle_room_dismissed"]])
                            disbandRoom(client.roomNumber)
                        }
                    }
                }
            } else {
                // OLD: if room still has clients, re-evaluate host auto-ready
                if (!client.isBattle) {
                    try {
                        const lobby = require("../tcp/lobby")
                        if (lobby.checkHostAutoReady) lobby.checkHostAutoReady(client.roomNumber)
                    } catch (e) {}
                }
            }
        }
        return { ok: true, value: undefined }
    }

    getClientsInRoom(roomNumber: string): SessionClient[] {
        const set = this.roomClients.get(roomNumber)
        if (!set) return []
        const out: SessionClient[] = []
        for (const addr of set) {
            const c = this.clients.get(addr)
            if (c) out.push(c)
        }
        return out
    }

    hasRoomClients(roomNumber: string): boolean {
        const set = this.roomClients.get(roomNumber)
        return !!set && set.size > 0
    }

    isHostOnline(hostViewerId: number, roomNumber: string): boolean {
        const set = this.roomClients.get(roomNumber)
        if (!set) return false
        for (const addr of set) {
            const c = this.clients.get(addr)
            if (c && !c.isBattle && c.viewerId === hostViewerId) return true
        }
        return false
    }

    addBattleClient(connectionId: string, client: SessionClient): void {
        let set = this.battleClients.get(client.roomNumber)
        if (!set) {
            set = new Set()
            this.battleClients.set(client.roomNumber, set)
        }
        set.add(connectionId)
        this.cidToBattleClient.set(connectionId, client)
    }

    removeBattleClient(connectionId: string): void {
        const client = this.cidToBattleClient.get(connectionId)
        if (client) {
            this.battleClients.get(client.roomNumber)?.delete(connectionId)
            this.sceneReadyClients.get(client.roomNumber)?.delete(connectionId)
        }
        this.cidToBattleClient.delete(connectionId)
    }

    getBattleClient(connectionId: string): SessionClient | undefined {
        return this.cidToBattleClient.get(connectionId)
    }

    markSceneReady(connectionId: string, roomNumber: string): boolean {
        const expected = this.battleExpectedCount.get(roomNumber) ?? 0
        if (expected <= 0) return false
        let readySet = this.sceneReadyClients.get(roomNumber)
        if (!readySet) {
            readySet = new Set()
            this.sceneReadyClients.set(roomNumber, readySet)
        }
        readySet.add(connectionId)
        const connected = this.battleClients.get(roomNumber)?.size ?? 0
        if (readySet.size >= expected && readySet.size >= connected) {
            this.battleExpectedCount.set(roomNumber, 0)
            return true
        }
        return false
    }

    clearSceneReady(roomNumber: string): void {
        this.sceneReadyClients.delete(roomNumber)
    }

    setBattleExpectedCount(roomNumber: string, count: number): void {
        this.battleExpectedCount.set(roomNumber, count)
    }

    clearBattleExpectedCount(roomNumber: string): void {
        this.battleExpectedCount.delete(roomNumber)
    }

    getRoomState(roomNumber: string): RoomStateMachine {
        let sm = this.roomStates.get(roomNumber)
        if (!sm) {
            sm = new RoomStateMachine()
            this.roomStates.set(roomNumber, sm)
        }
        return sm
    }

    removeRoomState(roomNumber: string): void {
        this.roomStates.delete(roomNumber)
    }

    sendJson(socket: net.Socket, data: any): void {
        if (!socket.writable) return
        socket.write(JSON.stringify(data) + "\0")
    }

    broadcastToRoom(roomNumber: string, data: any, excludeAddr?: string): void {
        const set = this.roomClients.get(roomNumber)
        if (!set) return
        for (const addr of set) {
            if (excludeAddr !== undefined && addr === excludeAddr) continue
            const c = this.clients.get(addr)
            if (c) this.sendJson(c.socket, data)
        }
    }

    getRoomClientCount(roomNumber: string): number {
        return this.roomClients.get(roomNumber)?.size ?? 0
    }
}

export const sessionManager = new SessionManager()
