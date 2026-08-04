import type { MultiRoom, QuestCategory } from "../types"
import {
    createRoom as createLocalRoom,
    disbandRoom as disbandLocalRoom,
    getRoom,
    getRoomByToken,
    updateHostEntryTime,
} from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import {
    MULTI_PROTOCOL_VERSION,
    type BattleSessionId,
    type CoordinatorResult,
    type MultiCompatibilityProfile,
    type NodeSessionId,
    type ParticipantIdentity,
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
    protocolVersion: MULTI_PROTOCOL_VERSION,
    appVersion: "embedded",
    resourceVersion: "embedded",
    cdnTargetVersion: "embedded",
    contentDigest: "embedded",
    modeDigest: "embedded",
})

const compatibilityByRoom = new WeakMap<MultiRoom, MultiCompatibilityProfile>()

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

function assertParticipant(participant: ParticipantIdentity): void {
    if (participant?.nodeSessionId !== EMBEDDED_NODE_SESSION_ID) {
        throw new TypeError("participant must use the embedded node session")
    }
    assertPositiveSafeInteger(participant.viewerId, "participant.viewerId")
}

function assertCompatibility(compatibility: MultiCompatibilityProfile): void {
    assertPositiveSafeInteger(compatibility?.protocolVersion, "compatibility.protocolVersion")
    assertNonEmptyString(compatibility?.appVersion, "compatibility.appVersion")
    assertNonEmptyString(compatibility?.resourceVersion, "compatibility.resourceVersion")
    assertNonEmptyString(compatibility?.cdnTargetVersion, "compatibility.cdnTargetVersion")
    assertNonEmptyString(compatibility?.contentDigest, "compatibility.contentDigest")
    assertNonEmptyString(compatibility?.modeDigest, "compatibility.modeDigest")
}

function assertNonEmptyString(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a non-empty string`)
    }
}

function resolveCompatibleRoom(input: CompatibleRoomInput): MultiRoom | undefined {
    assertParticipant(input.participant)
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

function unavailableBattle(): CoordinatorResult<BattleStatus> {
    return { ok: false, error: "HUB_UNAVAILABLE" }
}

export class EmbeddedMultiCoordinator implements MultiCoordinator {
    async createRoom(input: CreateRoomInput): Promise<CoordinatorResult<RoomStatus>> {
        assertNonEmptyString(input.requestId, "requestId")
        assertParticipant(input.participant)
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
        assertParticipant(input.participant)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        const room = getRoom(input.roomNumber)
        if (!room) return roomNotFound()
        if (room.host_viewer_id !== input.participant.viewerId) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }

        sessionManager.broadcastToRoom(input.roomNumber, [1, [6, "multibattle_room_dismissed"]])
        if (!disbandLocalRoom(input.roomNumber)) return roomNotFound()
        compatibilityByRoom.delete(room)
        return ok(undefined)
    }

    async startBattle(input: RoomParticipantInput): Promise<CoordinatorResult<BattleStatus>> {
        assertParticipant(input.participant)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        return unavailableBattle()
    }

    async finalizeBattle(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        this.assertBattleInput(input)
        return unavailableBattle()
    }

    async getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>> {
        this.assertBattleInput(input)
        return unavailableBattle()
    }

    async getRoomStatus(input: RoomParticipantInput): Promise<CoordinatorResult<RoomStatus>> {
        assertParticipant(input.participant)
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
        if (refreshHostEntryTime) updateHostEntryTime(room.room_number)
        return ok(this.toRoomStatus(room))
    }

    private assertBattleInput(input: BattleSessionInput): void {
        assertParticipant(input.participant)
        assertNonEmptyString(input.battleSessionId as BattleSessionId, "battleSessionId")
    }

    private toRoomStatus(room: MultiRoom): RoomStatus {
        const identity = (viewerId: number): ParticipantIdentity => ({
            nodeSessionId: EMBEDDED_NODE_SESSION_ID,
            viewerId,
        })
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
            host: Object.freeze(identity(room.host_viewer_id)),
            members: Object.freeze(room.member_viewer_ids.map(
                viewerId => Object.freeze(identity(viewerId)),
            )),
            compatibility: compatibilityByRoom.get(room) ?? EMBEDDED_COMPATIBILITY,
        })
    }
}
