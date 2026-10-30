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
    removeRoomMember,
} from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import { identityOf, lifecycleRegistry } from "../lifecycle"
import type { SessionClient } from "../state/SessionManager"
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

// R-09 拒绝分级：可恢复拒绝走优雅 Denied（客户端 case1 = 按连接被拒处理，
// 可提示后回大厅/重试），仅协议级参数错误与内部错误保留 Fatal [3]。
//
// 优雅 Denied 的第二项不是协议字面量，而是客户端 ui_string 的文案 key：
// 客户端 EnterRoomService.socketInput_denied 会把它传给 DialogContent.Text →
// getUiString；发 "DENIED" 会查不到 key 并抛 C8601（部分资源文件已损坏）。
const GRACEFUL_DENIAL_TEXT_KEYS: Readonly<Record<string, string>> = Object.freeze({
    room_missing: "multibattle_room_dismissed",
    room_full: "multibattle_room_filled",
    quest_mismatch: "multibattle_room_stale_room",
    admission_unavailable: "multibattle_room_not_found",
    admission_viewer_mismatch: "multibattle_room_not_found",
    viewer_conflict: "multibattle_room_not_found",
    room_generation_unavailable: "multibattle_room_not_found",
    admission_generation_mismatch: "multibattle_room_dismissed",
    host_seat_conflict: "multibattle_room_not_found",
    room_member_write_failed: "multibattle_room_not_found",
})

function gracefulDenialTextKey(reason: string): string {
    if (reason === "room_state_4") return "multibattle_room_already_started"
    if (reason.startsWith("room_state_")) return "multibattle_room_dismissed"
    if (reason.startsWith("room_join_")) return "multibattle_room_not_found"
    return GRACEFUL_DENIAL_TEXT_KEYS[reason] ?? "multibattle_room_not_found"
}

/** 内核握手拒绝 → 优雅拒绝 reason（沿用现有 ui_string 映射表）。 */
function kernelHandshakeDenialReason(rejected: string, phase: string): string {
    switch (rejected) {
        case "ROOM_FULL":
            return "room_full"
        case "STALE_GENERATION":
            return "admission_generation_mismatch"
        case "ROOM_CLOSING":
        case "ROOM_CLOSED":
        case "ROOM_NOT_JOINABLE":
            return phase === "battle" ? "room_state_4" : "room_state_9"
        default:
            return "admission_unavailable"
    }
}

function denyGracefully(socket: net.Socket, reason: string): void {
    const textKey = gracefulDenialTextKey(reason)
    console.log(`[TCP] handshake denied (graceful): ${reason} → ${textKey}`)
    sessionManager.sendJson(socket, [1, textKey])
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
        const releaseAdmission = (): void => {
            try {
                dependencies.admissionProvider.release?.(
                    normalizedRoomNumber,
                    normalizedViewerId,
                )
            } catch {}
        }
        const occupiedRealPlayerSlots = room?.member_participants.length ?? 0
        const existingMember = room ? isRoomViewerMember(room, normalizedViewerId) : false
        if (!room
            || (room.raising_state !== 1 && room.raising_state !== 2)
            || !categoryMatches
            || !questMatches
            || (!existingMember && occupiedRealPlayerSlots >= 3)) {
            releaseAdmission()
            denyGracefully(socket, !room
                ? "room_missing"
                : room.raising_state !== 1 && room.raising_state !== 2
                    ? `room_state_${room.raising_state}`
                    : !categoryMatches || !questMatches
                        ? "quest_mismatch"
                        : "room_full")
            return
        }

        const admission = dependencies.admissionProvider.consume(
            normalizedRoomNumber,
            normalizedViewerId,
        )
        if (!admission) {
            denyGracefully(socket, "admission_unavailable")
            return
        }
        if (admission.participant.viewerId !== normalizedViewerId) {
            releaseAdmission()
            denyGracefully(socket, "admission_viewer_mismatch")
            return
        }

        if (!lifecycle.isAccepting()) {
            releaseAdmission()
            return
        }
        const isRoomHost = normalizedViewerId === room.host_viewer_id
        if (sessionManager.hasActiveRoomViewerConflict(
            normalizedRoomNumber,
            admission.participant,
        ) || hasRoomMemberViewerConflict(room, admission.participant)) {
            releaseAdmission()
            denyGracefully(socket, "viewer_conflict")
            return
        }

        const client = sessionManager.createClient(
            socket,
            normalizedViewerId,
            normalizedRoomNumber,
            normalizedConnectionId,
        )
        client.participant = admission.participant
        client.snapshot = admission.snapshot
        client.npcPartySnapshots = admission.snapshot.npcParties
        // 代次以本节点 registry（owner）为准；票面只做一致性校验，旧票不得入新号房。
        const roomGeneration = lifecycleRegistry.get(normalizedRoomNumber)?.generation
        if (roomGeneration === undefined) {
            // 活房间在 owner 节点必有内核条目；缺失说明代次无法绑定，
            // 拒绝而不是放行一张无代次票（否则旧票可绕过房号复用守卫）。
            releaseAdmission()
            denyGracefully(socket, "room_generation_unavailable")
            return
        }
        if (admission.lifecycleGeneration !== undefined
            && admission.lifecycleGeneration !== roomGeneration) {
            releaseAdmission()
            denyGracefully(socket, "admission_generation_mismatch")
            return
        }
        client.lifecycleGeneration = roomGeneration
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
            releaseAdmission()
            denyGracefully(socket, "host_seat_conflict")
            return
        }
        const added = sessionManager.addClientToRoom(client)
        if (!added.ok) {
            releaseAdmission()
            denyGracefully(socket, `room_join_${added.error}`)
            return
        }
        if (!addRoomMember(normalizedRoomNumber, admission.participant)) {
            releaseAdmission()
            sessionManager.removeClient(client)
            denyGracefully(socket, "room_member_write_failed")
            return
        }
        // B2a 影子：admit 在入场票签发时记录；这里只记录 handshake。
        const viewerKey = identityOf(admission.participant)
        const handshakeDecision = lifecycleRegistry.dispatch(normalizedRoomNumber, generation => ({
            type: "handshake",
            generation,
            identity: viewerKey,
        }), client.lifecycleGeneration)
        // 内核拒绝=该 viewer 已不能进（迟到票/容量/相位在签发后变化）：
        // 回滚本段全部外壳写入再优雅拒绝——外壳成员账不得越过内核账。
        if (handshakeDecision?.rejected) {
            removeRoomMember(normalizedRoomNumber, admission.participant)
            sessionManager.removeClient(client)
            releaseAdmission()
            denyGracefully(socket, kernelHandshakeDenialReason(
                handshakeDecision.rejected,
                handshakeDecision.state.phase,
            ))
            return
        }
        sessionManager.sendJson(socket, [0, normalizedConnectionId, normalizedRoomNumber])
        return
    }

    // Unknown socklet
    sessionManager.sendJson(socket, [1, "DENIED"])
    socket.end()
}
