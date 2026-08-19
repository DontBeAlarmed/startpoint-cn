// Multi battle TCP session handshake
// Protocol: JSON messages delimited by null byte (\0)
// Post-handshake messages use typepacker format with useEnumIndex=true:
//   [index, param1, param2, ...]
//
// HandshakeResult: Accept=0, Denied=1, Reconnect=2, Exception=3, Complete=4

import * as net from "net"
import {
    addRoomMember,
    getRoom,
    hasRoomMemberViewerConflict,
    isRoomViewerMember,
} from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import type { SessionClient } from "../state/SessionManager"
import { ClientState } from "../types"
import {
    embeddedAdmissionRegistry,
    type AdmissionProvider,
} from "../admission/registry"
import { buildYourselfFromSnapshot } from "../snapshot/player-snapshot"

export interface HandshakeLifecycleGuard {
    /** Identifies the session-server generation that accepted this socket. */
    readonly generation: number
    /** Must be checked immediately before registering session or room state. */
    isAccepting(): boolean
}

const unmanagedLifecycle: HandshakeLifecycleGuard = Object.freeze({
    generation: 0,
    isAccepting: () => true,
})

export interface HandshakeDependencies {
    readonly admissionProvider: AdmissionProvider
}

const defaultDependencies: HandshakeDependencies = Object.freeze({
    admissionProvider: embeddedAdmissionRegistry,
})

function normalizeNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null
}

function normalizeViewerId(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null
}

function deny(socket: net.Socket): void {
    sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
    socket.end()
}

export async function handleHandshake(
    socket: net.Socket,
    data: any,
    lifecycle: HandshakeLifecycleGuard = unmanagedLifecycle,
    dependencies: HandshakeDependencies = defaultDependencies,
): Promise<void> {
    console.log("[TCP] handshake received")

    const socklet = data.socklet
    const roomNumber = data.room_number || data.roomNumber

    if (socklet === "cooperation_battle") {
        const connectionId = data.connection_id || data.connectionId || `${socket.remoteAddress}:${socket.remotePort}`
        if (!roomNumber) {
            console.log("[TCP] battle handshake denied: reason=invalid_room")
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }

        if (!lifecycle.isAccepting()) return
        const normalizedRoomNumber = String(roomNumber)
        const normalizedConnectionId = String(connectionId)
        const room = getRoom(normalizedRoomNumber)
        const participant = room?.raising_state === 4
            ? sessionManager.getBattleParticipant(normalizedRoomNumber, normalizedConnectionId)
            : undefined
        if (!participant || sessionManager.getBattleClient(normalizedConnectionId)) {
            const reason = !room
                ? "missing_room"
                : room.raising_state !== 4
                    ? "room_not_active"
                    : !participant
                        ? "unknown_participant"
                        : "duplicate_connection"
            console.log(`[TCP] battle handshake denied: reason=${reason}`)
            sessionManager.sendJson(socket, [3, "HANDSHAKE_DENIED"])
            socket.end()
            return
        }
        const battleClient = sessionManager.createClient(
            socket,
            participant.participant.viewerId,
            normalizedRoomNumber,
            normalizedConnectionId,
        )
        battleClient.participant = participant.participant
        battleClient.isBattle = true
        if (!sessionManager.addBattleClient(normalizedConnectionId, battleClient)) {
            deny(socket)
            return
        }
        sessionManager.sendJson(socket, [0, roomNumber, ""])
        console.log(`[TCP] battle handshake accepted: room=${normalizedRoomNumber}`)
        return
    }

    if (socklet === "cooperation_room") {
        const normalizedRoomNumber = normalizeNonEmptyString(roomNumber)
        const normalizedViewerId = normalizeViewerId(data.viewerId)
        const suppliedConnectionId = data.connection_id ?? data.connectionId
        const normalizedConnectionId = suppliedConnectionId === undefined
            ? normalizeNonEmptyString(`${socket.remoteAddress}:${socket.remotePort}`)
            : normalizeNonEmptyString(suppliedConnectionId)
        if (!normalizedRoomNumber || normalizedViewerId === null || !normalizedConnectionId) {
            deny(socket)
            return
        }

        const room = getRoom(normalizedRoomNumber)
        const categoryMatches = data.questCategory === undefined
            || (Number.isSafeInteger(data.questCategory) && data.questCategory === room?.category)
        const questMatches = data.questId === undefined
            || (Number.isSafeInteger(data.questId) && data.questId === room?.quest_id)
        const occupiedRealPlayerSlots = room?.member_participants.length ?? 0
        const existingMember = room ? isRoomViewerMember(room, normalizedViewerId) : false
        if (!room
            || (room.raising_state !== 1 && room.raising_state !== 2)
            || !categoryMatches
            || !questMatches
            || (!existingMember && occupiedRealPlayerSlots >= 3)) {
            deny(socket)
            return
        }

        const admission = dependencies.admissionProvider.consume(
            normalizedRoomNumber,
            normalizedViewerId,
        )
        if (!admission) {
            deny(socket)
            return
        }
        if (admission.participant.viewerId !== normalizedViewerId) {
            deny(socket)
            return
        }

        if (!lifecycle.isAccepting()) return
        const isRoomHost = normalizedViewerId === room.host_viewer_id
        if (sessionManager.hasActiveRoomViewerConflict(
            normalizedRoomNumber,
            admission.participant,
        ) || hasRoomMemberViewerConflict(room, admission.participant)) {
            deny(socket)
            return
        }

        const client = sessionManager.createClient(
            socket,
            normalizedViewerId,
            normalizedRoomNumber,
            normalizedConnectionId,
        )
        client.clientState.tryTransition(ClientState.Handshaking)
        client.participant = admission.participant
        client.snapshot = admission.snapshot
        client.npcPartySnapshots = admission.snapshot.npcParties
        client.yourself = buildYourselfFromSnapshot(
            admission.snapshot,
            normalizedConnectionId,
            isRoomHost,
        ) as SessionClient["yourself"]

        if (!lifecycle.isAccepting()) return
        if (isRoomHost && !sessionManager.claimRoomHostParticipant(
            normalizedRoomNumber,
            admission.participant,
        )) {
            deny(socket)
            return
        }
        const added = sessionManager.addClientToRoom(client)
        if (!added.ok) {
            deny(socket)
            return
        }
        if (!addRoomMember(normalizedRoomNumber, admission.participant)) {
            sessionManager.removeClient(client)
            deny(socket)
            return
        }
        sessionManager.sendJson(socket, [0, normalizedConnectionId, normalizedRoomNumber])
        return
    }

    // Unknown socklet
    sessionManager.sendJson(socket, [1, "DENIED"])
    socket.end()
}
