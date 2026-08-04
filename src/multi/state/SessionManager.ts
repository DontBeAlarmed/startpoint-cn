// Multi battle session manager
// Atomic indexing of room clients, battle clients and per-room state machines.
// Protocol arrays follow typepacker useEnumIndex=true format (see sessionServer.ts).

import * as net from "net"
import { Result, ClientState, BattleState } from "../types"
import { RoomStateMachine } from "./RoomStateMachine"
import { ClientStateMachine } from "./ClientStateMachine"
import { participantKey, type ParticipantIdentity } from "../coordinator/contracts"
import type { PlayerPartySnapshot, PlayerSnapshot } from "../snapshot/player-snapshot"

export interface SessionMate {
    viewerId: number
    connectionId: string
    party: unknown
    state?: unknown[]
    comId?: number
    name?: string
    rank?: number
    degreeId?: number
    mainCharacterId?: number
    playerRoleKind?: number
    isNewbie?: boolean
    isHost?: boolean
    currentPartyId?: number
    [key: string]: unknown
}

export interface SessionClient {
    socket: net.Socket
    viewerId: number
    roomNumber: string
    connectionId: string
    participant?: ParticipantIdentity
    snapshot?: PlayerSnapshot
    npcPartySnapshots: readonly PlayerPartySnapshot[]
    isBattle: boolean
    isReady: boolean
    buffer: string
    mates: SessionMate[]
    enterData: unknown
    yourself?: SessionMate
    clientState: ClientStateMachine
    battleState: BattleState
}

export interface BattleParticipant {
    participant: ParticipantIdentity
}

export class SessionManager {
    private clients = new Map<string, SessionClient>()
    private roomClients = new Map<string, Set<string>>()
    private battleClients = new Map<string, Set<string>>()
    private cidToBattleClient = new Map<string, SessionClient>()
    private sceneReadyClients = new Map<string, Set<string>>()
    private sceneTransitionClients = new Map<string, Set<string>>()
    private battleStartDeliveredClients = new Map<string, Map<number, Set<string>>>()
    private battleExpectedCount = new Map<string, number>()
    private battleParticipants = new Map<string, Map<string, BattleParticipant>>()
    private battleHostParticipants = new Map<string, ParticipantIdentity>()
    private battleSceneGeneration = new Map<string, number>()
    private finalizedBattleParticipantKeys = new Map<string, Set<string>>()
    private roomHostParticipants = new Map<string, ParticipantIdentity>()
    private roomStates = new Map<string, RoomStateMachine>()

    private roomClientKey(roomNumber: string, participant: ParticipantIdentity): string {
        return JSON.stringify([roomNumber, participant.nodeSessionId, participant.viewerId])
    }

    createClient(socket: net.Socket, viewerId: number, roomNumber: string, connectionId: string): SessionClient {
        return {
            socket,
            viewerId,
            roomNumber,
            connectionId,
            npcPartySnapshots: [],
            isBattle: false,
            isReady: false,
            buffer: "",
            mates: [],
            enterData: null,
            clientState: new ClientStateMachine(ClientState.Connecting),
            battleState: BattleState.Initializing,
        }
    }

    getClientByParticipant(
        roomNumber: string,
        participant: ParticipantIdentity,
    ): SessionClient | undefined {
        return this.clients.get(this.roomClientKey(roomNumber, participant))
    }

    getUniqueRoomClientByViewerId(
        viewerId: number,
        roomNumber: string,
    ): SessionClient | undefined {
        const matches = this.getClientsInRoom(roomNumber)
            .filter(client => client.viewerId === viewerId)
        return matches.length === 1 ? matches[0] : undefined
    }

    getClientBySocket(socket: net.Socket): SessionClient | undefined {
        for (const client of this.clients.values()) {
            if (client.socket === socket) return client
        }
        return undefined
    }

    hasActiveRoomViewerConflict(
        roomNumber: string,
        participant: ParticipantIdentity,
    ): boolean {
        const identityKey = participantKey(participant.nodeSessionId, participant.viewerId)
        return this.getClientsInRoom(roomNumber).some(client => (
            client.viewerId === participant.viewerId
            && (!client.participant || participantKey(
                client.participant.nodeSessionId,
                client.participant.viewerId,
            ) !== identityKey)
        ))
    }

    claimRoomHostParticipant(
        roomNumber: string,
        participant: ParticipantIdentity,
    ): boolean {
        const existing = this.roomHostParticipants.get(roomNumber)
        if (existing) {
            return participantKey(existing.nodeSessionId, existing.viewerId)
                === participantKey(participant.nodeSessionId, participant.viewerId)
        }
        this.roomHostParticipants.set(roomNumber, Object.freeze({ ...participant }))
        return true
    }

    isRoomHostParticipant(roomNumber: string, participant: ParticipantIdentity): boolean {
        const host = this.roomHostParticipants.get(roomNumber)
        return host !== undefined
            && participantKey(host.nodeSessionId, host.viewerId)
                === participantKey(participant.nodeSessionId, participant.viewerId)
    }

    getRoomHostClient(roomNumber: string): SessionClient | undefined {
        const host = this.roomHostParticipants.get(roomNumber)
        return host ? this.getClientByParticipant(roomNumber, host) : undefined
    }

    addClientToRoom(client: SessionClient): Result<void> {
        if (!client.participant) return { ok: false, error: "PARTICIPANT_REQUIRED" }
        if (this.hasActiveRoomViewerConflict(client.roomNumber, client.participant)) {
            return { ok: false, error: "VIEWER_ID_CONFLICT" }
        }
        const addr = this.roomClientKey(client.roomNumber, client.participant)
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
            if (this.isSceneBarrierComplete(client.roomNumber)) {
                this.broadcastBattleStart(client.roomNumber)
            }
            if ((this.battleClients.get(client.roomNumber)?.size ?? 0) === 0) {
                const { getRoom } = require("../room/manager")
                const room = getRoom(client.roomNumber)
                if (room && room.raising_state !== 4) this.clearBattleSceneState(client.roomNumber)
            }
            return { ok: true, value: undefined }
        }

        if (!client.participant) return { ok: true, value: undefined }
        const addr = this.roomClientKey(client.roomNumber, client.participant)
        if (this.clients.get(addr) !== client) return { ok: true, value: undefined }
        this.clients.delete(addr)
        const set = this.roomClients.get(client.roomNumber)
        if (set) {
            set.delete(addr)
            if (set.size === 0) {
                this.roomClients.delete(client.roomNumber)
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

    removeClientBySocket(socket: net.Socket): boolean {
        for (const client of this.clients.values()) {
            if (client.socket === socket) {
                this.removeClient(client)
                return true
            }
        }
        for (const client of this.cidToBattleClient.values()) {
            if (client.socket === socket) {
                this.removeClient(client)
                return true
            }
        }
        return false
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

    isUniqueRoomViewerOnline(viewerId: number, roomNumber: string): boolean {
        return this.getUniqueRoomClientByViewerId(viewerId, roomNumber) !== undefined
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
            this.sceneTransitionClients.get(client.roomNumber)?.delete(connectionId)
        }
        this.cidToBattleClient.delete(connectionId)
    }

    getBattleClient(connectionId: string): SessionClient | undefined {
        return this.cidToBattleClient.get(connectionId)
    }

    getBattleClientsInRoom(roomNumber: string): SessionClient[] {
        const clients: SessionClient[] = []
        for (const connectionId of this.battleClients.get(roomNumber) ?? []) {
            const client = this.cidToBattleClient.get(connectionId)
            if (client) clients.push(client)
        }
        return clients
    }

    getBattleParticipant(roomNumber: string, connectionId: string): BattleParticipant | undefined {
        return this.battleParticipants.get(roomNumber)?.get(connectionId)
    }

    isBattleHostParticipant(roomNumber: string, identity: ParticipantIdentity): boolean {
        const host = this.battleHostParticipants.get(roomNumber)
        return host !== undefined
            && participantKey(host.nodeSessionId, host.viewerId)
                === participantKey(identity.nodeSessionId, identity.viewerId)
    }

    removeBattleParticipant(roomNumber: string, identity: ParticipantIdentity): boolean {
        const identityKey = participantKey(identity.nodeSessionId, identity.viewerId)
        const participants = this.battleParticipants.get(roomNumber)
        const connectionIds = participants
            ? [...participants.entries()]
                .filter(([, participant]) => participantKey(
                    participant.participant.nodeSessionId,
                    participant.participant.viewerId,
                ) === identityKey)
                .map(([connectionId]) => connectionId)
            : []

        let removed = false
        for (const connectionId of connectionIds) {
            const battleClient = this.cidToBattleClient.get(connectionId)
            if (battleClient?.participant && participantKey(
                battleClient.participant.nodeSessionId,
                battleClient.participant.viewerId,
            ) === identityKey) {
                this.removeClient(battleClient)
            } else {
                this.sceneReadyClients.get(roomNumber)?.delete(connectionId)
                this.sceneTransitionClients.get(roomNumber)?.delete(connectionId)
                const expected = this.battleExpectedCount.get(roomNumber)
                if (expected !== undefined && expected > 1) {
                    this.battleExpectedCount.set(roomNumber, expected - 1)
                }
                if (this.isSceneBarrierComplete(roomNumber)) {
                    this.broadcastBattleStart(roomNumber)
                }
            }
            participants?.delete(connectionId)
            removed = true
        }
        if (participants?.size === 0) this.battleParticipants.delete(roomNumber)

        const finalized = this.finalizedBattleParticipantKeys.get(roomNumber)
        if (finalized?.delete(identityKey)) removed = true
        if (finalized?.size === 0) this.finalizedBattleParticipantKeys.delete(roomNumber)
        return removed
    }

    broadcastToBattleRoom(roomNumber: string, data: unknown): void {
        for (const client of this.getBattleClientsInRoom(roomNumber)) {
            this.sendJson(client.socket, data)
        }
    }

    broadcastBattleStart(roomNumber: string): void {
        const generation = this.battleSceneGeneration.get(roomNumber) ?? -1
        if (generation < 0) return
        let deliveredByGeneration = this.battleStartDeliveredClients.get(roomNumber)
        if (!deliveredByGeneration) {
            deliveredByGeneration = new Map()
            this.battleStartDeliveredClients.set(roomNumber, deliveredByGeneration)
        }
        let delivered = deliveredByGeneration.get(generation)
        if (!delivered) {
            delivered = new Set()
            deliveredByGeneration.set(generation, delivered)
        }
        for (const client of this.getBattleClientsInRoom(roomNumber)) {
            if (this.sendJson(client.socket, [1, [1]])) {
                delivered.add(client.connectionId)
            }
        }
    }

    replayBattleStartIfNeeded(connectionId: string, roomNumber: string): boolean {
        const currentGeneration = this.battleSceneGeneration.get(roomNumber) ?? -1
        if (currentGeneration < 0) return false
        const client = this.cidToBattleClient.get(connectionId)
        if (!client) return false

        let deliveredByGeneration = this.battleStartDeliveredClients.get(roomNumber)
        for (let generation = 0; generation <= currentGeneration; generation++) {
            if (deliveredByGeneration?.get(generation)?.has(connectionId)) continue
            if (generation === currentGeneration) {
                if ((this.battleExpectedCount.get(roomNumber) ?? -1) !== 0) return false
                if (generation === 1
                    && !this.sceneTransitionClients.get(roomNumber)?.has(connectionId)) return false
            }
            if (!deliveredByGeneration) {
                deliveredByGeneration = new Map()
                this.battleStartDeliveredClients.set(roomNumber, deliveredByGeneration)
            }
            let delivered = deliveredByGeneration.get(generation)
            if (!delivered) {
                delivered = new Set()
                deliveredByGeneration.set(generation, delivered)
            }
            if (!this.sendJson(client.socket, [1, [1]])) return false
            delivered.add(connectionId)
            return true
        }
        return false
    }

    private isSceneBarrierComplete(roomNumber: string): boolean {
        const expected = this.battleExpectedCount.get(roomNumber) ?? 0
        if (expected <= 0) return false
        const ready = this.sceneReadyClients.get(roomNumber)?.size ?? 0
        const connected = this.battleClients.get(roomNumber)?.size ?? 0
        if (ready < expected || ready < connected) return false
        this.battleExpectedCount.set(roomNumber, 0)
        return true
    }

    markSceneReady(connectionId: string, roomNumber: string): boolean {
        const expected = this.battleExpectedCount.get(roomNumber) ?? 0
        if (expected <= 0) return false
        if ((this.battleSceneGeneration.get(roomNumber) ?? 0) === 1
            && !this.sceneTransitionClients.get(roomNumber)?.has(connectionId)) return false
        let readySet = this.sceneReadyClients.get(roomNumber)
        if (!readySet) {
            readySet = new Set()
            this.sceneReadyClients.set(roomNumber, readySet)
        }
        readySet.add(connectionId)
        return this.isSceneBarrierComplete(roomNumber)
    }

    beginNextBattleScene(connectionId: string, roomNumber: string): boolean {
        const generation = this.battleSceneGeneration.get(roomNumber) ?? -1
        const expected = this.battleExpectedCount.get(roomNumber) ?? -1
        if (generation === 1) {
            this.sceneTransitionClients.get(roomNumber)?.add(connectionId)
            return false
        }
        if (generation !== 0 || expected !== 0) return false
        const connected = this.battleClients.get(roomNumber)?.size ?? 0
        if (connected <= 0) return false
        this.battleSceneGeneration.set(roomNumber, 1)
        this.sceneTransitionClients.set(roomNumber, new Set([connectionId]))
        this.sceneReadyClients.set(roomNumber, new Set())
        this.battleExpectedCount.set(roomNumber, connected)
        return true
    }

    canFinalizeBattle(roomNumber: string, requiresNextScene: boolean): boolean {
        if ((this.battleExpectedCount.get(roomNumber) ?? -1) !== 0) return false
        const generation = this.battleSceneGeneration.get(roomNumber) ?? -1
        return generation === (requiresNextScene ? 1 : 0)
    }

    markBattleFinalized(connectionId: string, roomNumber: string): boolean {
        const participant = this.cidToBattleClient.get(connectionId)?.participant
        if (!participant) return false
        this.markParticipantFinalizedBattle(roomNumber, participant)
        return true
    }

    markParticipantFinalizedBattle(roomNumber: string, participant: ParticipantIdentity): void {
        let finalized = this.finalizedBattleParticipantKeys.get(roomNumber)
        if (!finalized) {
            finalized = new Set()
            this.finalizedBattleParticipantKeys.set(roomNumber, finalized)
        }
        finalized.add(participantKey(participant.nodeSessionId, participant.viewerId))
    }

    hasParticipantFinalizedBattle(roomNumber: string, participant: ParticipantIdentity): boolean {
        return this.finalizedBattleParticipantKeys.get(roomNumber)?.has(
            participantKey(participant.nodeSessionId, participant.viewerId),
        ) === true
    }

    consumeParticipantFinalizedBattle(roomNumber: string, participant: ParticipantIdentity): boolean {
        const finalized = this.finalizedBattleParticipantKeys.get(roomNumber)
        if (!finalized?.delete(participantKey(
            participant.nodeSessionId,
            participant.viewerId,
        ))) return false
        if (finalized.size === 0) this.finalizedBattleParticipantKeys.delete(roomNumber)
        return true
    }

    hasBattleClients(roomNumber: string): boolean {
        return (this.battleClients.get(roomNumber)?.size ?? 0) > 0
    }

    clearSceneReady(roomNumber: string): void {
        this.sceneReadyClients.delete(roomNumber)
    }

    setBattleExpectedCount(roomNumber: string, count: number): void {
        this.battleParticipants.delete(roomNumber)
        this.battleHostParticipants.delete(roomNumber)
        this.resetBattleScene(roomNumber, count)
    }

    setBattleParticipants(
        roomNumber: string,
        participants: Array<{
            connectionId: string
            participant: ParticipantIdentity
        }>,
        hostParticipant: ParticipantIdentity,
    ): void {
        const participantMap = new Map<string, BattleParticipant>()
        for (const participant of participants) {
            if (!participant.connectionId) continue
            participantMap.set(participant.connectionId, {
                participant: Object.freeze({ ...participant.participant }),
            })
        }
        this.battleParticipants.set(roomNumber, participantMap)
        this.battleHostParticipants.set(roomNumber, Object.freeze({ ...hostParticipant }))
        this.resetBattleScene(roomNumber, participantMap.size)
    }

    private resetBattleScene(roomNumber: string, count: number): void {
        this.sceneReadyClients.delete(roomNumber)
        this.sceneTransitionClients.delete(roomNumber)
        this.battleStartDeliveredClients.delete(roomNumber)
        this.finalizedBattleParticipantKeys.delete(roomNumber)
        this.battleSceneGeneration.set(roomNumber, 0)
        this.battleExpectedCount.set(roomNumber, count)
    }

    clearBattleSceneState(roomNumber: string): void {
        this.battleExpectedCount.delete(roomNumber)
        this.sceneReadyClients.delete(roomNumber)
        this.sceneTransitionClients.delete(roomNumber)
        this.battleStartDeliveredClients.delete(roomNumber)
        this.battleSceneGeneration.delete(roomNumber)
    }

    clearBattleExpectedCount(roomNumber: string): void {
        this.clearBattleSceneState(roomNumber)
        this.battleParticipants.delete(roomNumber)
        this.battleHostParticipants.delete(roomNumber)
        this.finalizedBattleParticipantKeys.delete(roomNumber)
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
        this.roomHostParticipants.delete(roomNumber)
        this.clearBattleExpectedCount(roomNumber)
    }

    sendJson(socket: net.Socket, data: any): boolean {
        if (!socket.writable) return false
        socket.write(JSON.stringify(data) + "\0")
        return true
    }

    broadcastToRoom(roomNumber: string, data: any, excludeClient?: SessionClient): void {
        const set = this.roomClients.get(roomNumber)
        if (!set) return
        const excludeAddr = excludeClient?.participant
            && excludeClient.roomNumber === roomNumber
            ? this.roomClientKey(roomNumber, excludeClient.participant)
            : undefined
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
