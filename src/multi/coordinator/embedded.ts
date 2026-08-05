import type { MultiRoom, QuestCategory } from "../types"
import {
    createRoom as createLocalRoom,
    disbandRoom as disbandLocalRoom,
    getRoom,
    getRoomByToken,
    listActiveRooms,
    updateRoomState,
    updateHostEntryTime,
} from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import { compareCompatibility } from "../compatibility"
import {
    MULTI_PROTOCOL_VERSION,
    type BattleSessionId,
    type CoordinatorResult,
    type MultiCompatibilityProfile,
    type NodeSessionId,
    type ParticipantIdentity,
    hasViewerIdConflict,
    participantKey,
} from "./contracts"
import type {
    BattleSessionInput,
    BattleStatus,
    CompatibleRoomInput,
    CreateRoomInput,
    MultiCoordinator,
    RoomParticipantInput,
    RoomStatus,
} from "./interface"

export const EMBEDDED_NODE_SESSION_ID = "embedded" as NodeSessionId

export const EMBEDDED_COMPATIBILITY: MultiCompatibilityProfile = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "embedded",
    RES_VER: "embedded",
    cdnTargetVersion: "embedded",
    contentDigest: `sha256:${"0".repeat(64)}`,
    modeDigest: `sha256:${"0".repeat(64)}`,
})

const compatibilityByRoom = new WeakMap<MultiRoom, MultiCompatibilityProfile>()
const hostIdentityByRoom = new WeakMap<MultiRoom, ParticipantIdentity>()

export interface EmbeddedMultiCoordinatorOptions {
    readonly allowRemoteParticipants?: boolean
}

function ok<T>(value: T): CoordinatorResult<T> {
    return { ok: true, value }
}

function roomNotFound<T>(): CoordinatorResult<T> {
    return { ok: false, error: "ROOM_NOT_FOUND" }
}

function assertPositiveSafeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
}

function assertParticipant(
    participant: ParticipantIdentity,
    allowRemoteParticipants: boolean,
): void {
    if (!allowRemoteParticipants && participant?.nodeSessionId !== EMBEDDED_NODE_SESSION_ID) {
        throw new TypeError("participant must use the embedded node session")
    }
    if (typeof participant?.nodeSessionId !== "string"
        || participant.nodeSessionId.trim().length === 0) {
        throw new TypeError("participant.nodeSessionId must be a non-empty string")
    }
    assertPositiveSafeInteger(participant.viewerId, "participant.viewerId")
}

function assertCompatibility(compatibility: MultiCompatibilityProfile): void {
    if (compatibility?.multiProtocolVersion !== MULTI_PROTOCOL_VERSION) {
        throw new TypeError("compatibility.multiProtocolVersion is unsupported")
    }
    assertNonEmptyString(compatibility?.APP_VER, "compatibility.APP_VER")
    assertNonEmptyString(compatibility?.RES_VER, "compatibility.RES_VER")
    assertNonEmptyString(compatibility?.cdnTargetVersion, "compatibility.cdnTargetVersion")
    assertSha256(compatibility?.contentDigest, "compatibility.contentDigest")
    assertSha256(compatibility?.modeDigest, "compatibility.modeDigest")
}

function assertSha256(value: string, field: string): void {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new TypeError(`${field} must be a sha256 digest`)
    }
}

function assertNonEmptyString(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a non-empty string`)
    }
}

function resolveCompatibleRoom(input: CompatibleRoomInput): MultiRoom | undefined {
    assertCompatibility(input.compatibility)

    const roomNumber = typeof input.roomNumber === "string" && input.roomNumber.trim().length > 0
        ? input.roomNumber
        : undefined
    const accessToken = typeof input.accessToken === "string" && input.accessToken.trim().length > 0
        ? input.accessToken
        : undefined
    if (roomNumber !== undefined && accessToken !== undefined) {
        throw new TypeError("only one non-empty room locator is allowed")
    }
    if (roomNumber !== undefined) return getRoom(roomNumber)
    if (accessToken !== undefined) return getRoomByToken(accessToken)
    return undefined
}

export class EmbeddedMultiCoordinator implements MultiCoordinator {
    private readonly allowRemoteParticipants: boolean

    constructor(options: EmbeddedMultiCoordinatorOptions = {}) {
        this.allowRemoteParticipants = options.allowRemoteParticipants === true
    }

    async createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        assertNonEmptyString(input.requestId, "requestId")
        assertParticipant(input.participant, this.allowRemoteParticipants)
        assertPositiveSafeInteger(input.partyId, "partyId")
        assertPositiveSafeInteger(input.category, "category")
        assertPositiveSafeInteger(input.questId, "questId")
        assertPositiveSafeInteger(input.leaderCharacterId, "leaderCharacterId")
        if (input.localPlayerId !== undefined) {
            assertPositiveSafeInteger(input.localPlayerId, "localPlayerId")
        }
        assertCompatibility(input.compatibility)

        const room = createLocalRoom(
            input.participant.viewerId,
            input.localPlayerId ?? input.participant.viewerId,
            input.partyId,
            input.category as QuestCategory,
            input.questId,
            0,
            input.leaderCharacterId,
        )
        compatibilityByRoom.set(room, Object.freeze({ ...input.compatibility }))
        hostIdentityByRoom.set(room, Object.freeze({ ...input.participant }))
        return ok(this.toRoomStatus(room))
    }

    async searchRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.resolveRoom(input, false)
    }

    async prepareRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.resolveRoom(input, true)
    }

    async selectRoom(input: CompatibleRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        return this.resolveRoom(input, false)
    }

    async disbandRoom(input: RoomParticipantInput): Promise<CoordinatorResult<void>> {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        const room = getRoom(input.roomNumber)
        if (!room) return roomNotFound()
        const host = hostIdentityByRoom.get(room) ?? {
            nodeSessionId: EMBEDDED_NODE_SESSION_ID,
            viewerId: room.host_viewer_id,
        }
        if (participantKey(host.nodeSessionId, host.viewerId)
            !== participantKey(input.participant.nodeSessionId, input.participant.viewerId)) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }

        if (!this.removeOwnedRoom(room)) return roomNotFound()
        return ok(undefined)
    }

    async abortBattle(input: RoomParticipantInput): Promise<CoordinatorResult<void>> {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        const room = getRoom(input.roomNumber)
        if (!room) return ok(undefined)
        const status = this.toRoomStatus(room)
        const identityKey = participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        )
        if (!status.members.some(member => participantKey(
            member.nodeSessionId,
            member.viewerId,
        ) === identityKey)) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }
        if (participantKey(status.host.nodeSessionId, status.host.viewerId) === identityKey) {
            return this.removeOwnedRoom(room) ? ok(undefined) : roomNotFound()
        }
        const factRemoval = sessionManager.removeBattleFactParticipant(input)
        if (!factRemoval.ok) return factRemoval
        sessionManager.removeBattleParticipant(input.roomNumber, input.participant)
        return ok(undefined)
    }

    cleanupNodeSession(nodeSessionId: NodeSessionId): number {
        let removed = 0
        for (const room of listActiveRooms()) {
            const host = hostIdentityByRoom.get(room)
            if (host?.nodeSessionId === nodeSessionId && this.removeOwnedRoom(room)) {
                removed++
            }
        }
        return removed
    }

    async startBattle(input: RoomParticipantInput): Promise<CoordinatorResult<BattleStatus>> {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        const room = getRoom(input.roomNumber)
        if (!room) return roomNotFound()
        const roomStatus = this.toRoomStatus(room)
        const identityKey = participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        )
        if (!roomStatus.members.some(member => participantKey(
            member.nodeSessionId,
            member.viewerId,
        ) === identityKey)) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }
        const battleSessionId = sessionManager.getActiveBattleSessionId(input.roomNumber)
        if (battleSessionId === null) return { ok: false, error: "HUB_UNAVAILABLE" }
        const battleInput = { ...input, battleSessionId }
        if (sessionManager.hasAnyFinalizedBattle(battleInput)) return roomNotFound()
        return sessionManager.authorizeBattleParticipant(battleInput)
    }

    async finalizeBattle(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        this.assertBattleInput(input)
        const result = sessionManager.getBattleStatus(input)
        if (!result.ok || !result.value.finalized) return result
        if (sessionManager.isBattleFullyFinalized(input)) {
            updateRoomState(input.roomNumber, 1)
            sessionManager.clearBattleExpectedCount(input.roomNumber)
        }
        return result
    }

    async getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        this.assertBattleInput(input)
        return sessionManager.getBattleStatus(input)
    }

    async getRoomStatus(input: RoomParticipantInput): Promise<CoordinatorResult<RoomStatus>> {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        const room = getRoom(input.roomNumber)
        return room ? ok(this.toRoomStatus(room)) : roomNotFound()
    }

    private async resolveRoom(
        input: CompatibleRoomInput,
        refreshHostEntryTime: boolean,
    ): Promise<CoordinatorResult<RoomStatus>> {
        const room = resolveCompatibleRoom(input)
        if (!room) return roomNotFound()
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (hasViewerIdConflict(this.toRoomStatus(room).members, input.participant)) {
            return { ok: false, error: "VIEWER_ID_CONFLICT" }
        }
        const hostCompatibility = compatibilityByRoom.get(room) ?? EMBEDDED_COMPATIBILITY
        if (!compareCompatibility(hostCompatibility, input.compatibility).compatible) {
            return { ok: false, error: "INCOMPATIBLE_ROOM" }
        }
        if (refreshHostEntryTime) updateHostEntryTime(room.room_number)
        return ok(this.toRoomStatus(room))
    }

    private assertBattleInput(input: BattleSessionInput): void {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        assertNonEmptyString(input.roomNumber, "roomNumber")
        assertNonEmptyString(input.battleSessionId as BattleSessionId, "battleSessionId")
    }

    private removeOwnedRoom(room: MultiRoom): boolean {
        sessionManager.broadcastToRoom(room.room_number, [1, [6, "multibattle_room_dismissed"]])
        sessionManager.closeRoomClients(room.room_number)
        if (!disbandLocalRoom(room.room_number)) return false
        compatibilityByRoom.delete(room)
        hostIdentityByRoom.delete(room)
        return true
    }

    private toRoomStatus(room: MultiRoom): RoomStatus {
        const host = hostIdentityByRoom.get(room) ?? Object.freeze({
            nodeSessionId: EMBEDDED_NODE_SESSION_ID,
            viewerId: room.host_viewer_id,
        })
        const battleSessionId = sessionManager.getActiveBattleSessionId(room.room_number)
        const connected = sessionManager.getClientsInRoom(room.room_number)
        const identity = (viewerId: number): ParticipantIdentity => {
            if (viewerId === host.viewerId) return host
            return connected.find(client => client.viewerId === viewerId)?.participant
                ?? { nodeSessionId: EMBEDDED_NODE_SESSION_ID, viewerId }
        }
        return Object.freeze({
            roomNumber: room.room_number,
            accessToken: room.access_token,
            category: room.category,
            questId: room.quest_id,
            hostEntryTime: room.host_entry_time,
            roomSequence: room.room_sequence,
            raisingState: room.raising_state,
            shareRoomOptions: room.share_room_options,
            hostMainCharacterId: room.host_main_character_id,
            isNpcMode: room.is_npc_mode,
            hostOnline: sessionManager.isUniqueRoomViewerOnline(
                room.host_viewer_id,
                room.room_number,
            ),
            host,
            members: Object.freeze(room.member_viewer_ids.map(
                viewerId => Object.freeze(identity(viewerId)),
            )),
            compatibility: compatibilityByRoom.get(room) ?? EMBEDDED_COMPATIBILITY,
            ...(battleSessionId === null ? {} : { battleSessionId }),
        })
    }
}
