import type { MultiRoom, QuestCategory } from "../types"
import { describeError } from "../describe-error"
import {
    createRoom as createLocalRoom,
    disbandRoom as disbandLocalRoom,
    getRoom,
    getRoomByToken,
    listActiveRooms,
    reconcileHostReturn,
    removeRoomMember,
    updateRoomState,
    updateHostEntryTime,
} from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import {
    identityOf,
    LIFECYCLE_BATTLE_DEADLINE_MS,
    LIFECYCLE_CLOSE_DEADLINE_MS,
    lifecycleRegistry,
} from "../lifecycle"
import { getRealNowMs } from "../../runtime/time/game-time"
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
    StartBattleInput,
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
    readonly onRoomDisband?: (roomNumber: string) => void
    /** 战斗 release 回房（4→1 成功）后回调：一场一换在此撤除 NPC 编队（尽力而为）；
     * battleSessionId 用于一代一闩（缺失 = 无战斗身份，闩为空串） */
    readonly onBattleReleased?: (roomNumber: string, battleSessionId?: string) => void
    readonly onCompatibilityRejection?: (input: {
        readonly code: "INCOMPATIBLE_ROOM"
        readonly differences: readonly {
            readonly field: string
            readonly required: string | number
            readonly received: string | number
        }[]
    }) => void
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
    private readonly onRoomDisband: EmbeddedMultiCoordinatorOptions["onRoomDisband"]
    private readonly onBattleReleased: EmbeddedMultiCoordinatorOptions["onBattleReleased"]
    private readonly onCompatibilityRejection: EmbeddedMultiCoordinatorOptions["onCompatibilityRejection"]

    constructor(options: EmbeddedMultiCoordinatorOptions = {}) {
        this.allowRemoteParticipants = options.allowRemoteParticipants === true
        this.onRoomDisband = options.onRoomDisband
        this.onBattleReleased = options.onBattleReleased
        this.onCompatibilityRejection = options.onCompatibilityRejection
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
            false,
            input.participant,
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
        return this.resolveRoom(input, true)
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
        lifecycleRegistry.dispatch(input.roomNumber, generation => ({
            type: "abort",
            generation,
            identity: identityOf(input.participant),
            nowMs: getRealNowMs(),
            battleDeadlineMs: LIFECYCLE_BATTLE_DEADLINE_MS,
            closeDeadlineMs: LIFECYCLE_CLOSE_DEADLINE_MS,
            battleSessionId: sessionManager.getActiveBattleSessionId(input.roomNumber) ?? "",
        }))
        sessionManager.removeBattleParticipant(input.roomNumber, input.participant)
        if (factRemoval.value) this.releaseIfFullyFinalized(factRemoval.value)
        return ok(undefined)
    }

    cleanupNodeSession(nodeSessionId: NodeSessionId): number {
        let removed = 0
        for (const room of listActiveRooms()) {
            const host = hostIdentityByRoom.get(room)
            if (host?.nodeSessionId === nodeSessionId) {
                try {
                    if (this.removeOwnedRoom(room, true)) removed++
                } catch {
                    this.warnNodeSessionCleanup(room.room_number)
                }
                continue
            }

            const invalidatedParticipants = sessionManager.getNodeSessionParticipants(
                room.room_number,
                nodeSessionId,
            )
            // B2a 影子：撤权删成员等价于战斗/座位上的 Abort，避免内核留下永不 finish 的参与者。
            const activeBattleSessionId = sessionManager.getActiveBattleSessionId(room.room_number) ?? ""
            for (const participant of invalidatedParticipants) {
                lifecycleRegistry.dispatch(room.room_number, generation => ({
                    type: "abort",
                    generation,
                    identity: identityOf(participant),
                    nowMs: getRealNowMs(),
                    battleDeadlineMs: LIFECYCLE_BATTLE_DEADLINE_MS,
                    closeDeadlineMs: LIFECYCLE_CLOSE_DEADLINE_MS,
                    battleSessionId: activeBattleSessionId,
                }))
            }
            let factStatus: BattleStatus | null = null
            let roomRemoved = false
            try {
                factStatus = sessionManager.removeBattleFactParticipantsByNodeSession(
                    room.room_number,
                    nodeSessionId,
                )
                roomRemoved = factStatus !== null
            } catch {
                this.warnNodeSessionCleanup(room.room_number)
            }
            if (factStatus) {
                try {
                    this.releaseIfFullyFinalized(factStatus)
                } catch {
                    this.warnNodeSessionCleanup(room.room_number)
                }
            }
            try {
                if (sessionManager.removeNodeSessionBattleState(
                    room.room_number,
                    nodeSessionId,
                )) roomRemoved = true
            } catch {
                this.warnNodeSessionCleanup(room.room_number)
            }
            try {
                if (this.removeInvalidatedRoomMembers(
                    room,
                    nodeSessionId,
                    invalidatedParticipants,
                )) {
                    roomRemoved = true
                }
            } catch {
                this.warnNodeSessionCleanup(room.room_number)
            }
            if (roomRemoved) removed++
        }
        return removed
    }

    async startBattle(input: StartBattleInput): Promise<CoordinatorResult<BattleStatus>> {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) {
            return roomNotFound()
        }
        const room = getRoom(input.roomNumber)
        if (!room) return roomNotFound()
        const compatibility = this.checkRoomCompatibility(room, input.compatibility)
        if (!compatibility.ok) return compatibility
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
        // B2a 影子：记录本参与者的 Finish；内核保持 state 4，等 HostReturn。
        lifecycleRegistry.dispatch(input.roomNumber, generation => ({
            type: "finish",
            generation,
            identity: identityOf(input.participant),
            nowMs: getRealNowMs(),
            battleDeadlineMs: LIFECYCLE_BATTLE_DEADLINE_MS,
            battleSessionId: String(input.battleSessionId),
        }))
        const result = sessionManager.getBattleStatus(input)
        if (!result.ok || !result.value.finalized) return result
        this.releaseIfFullyFinalized(result.value)
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
        if (!room) return roomNotFound()
        if (input.participant.viewerId === room.host_viewer_id) {
            // restore_room 是房主真实回房路径；账实同 prepare/select。
            updateHostEntryTime(room.room_number)
            // /start、share、summon 也走 getRoomStatus：只有战斗事实已释放
            // （或房主已 finish）才允许闩锁，避免开战瞬间误触发 HostReturn。
            const battleReleased = sessionManager.getActiveBattleSessionId(room.room_number) === null
                || sessionManager.hasParticipantFinalizedBattle(room.room_number, input.participant)
            if (battleReleased) {
                const hostIdentity = lifecycleRegistry.hostOf(room.room_number)
                if (hostIdentity !== undefined) {
                    lifecycleRegistry.dispatch(room.room_number, generation => ({
                        type: "hostReturn",
                        generation,
                        identity: hostIdentity,
                        nowMs: getRealNowMs(),
                    }))
                    reconcileHostReturn(room.room_number)
                }
            }
        }
        return ok(this.toRoomStatus(room))
    }

    private async resolveRoom(
        input: CompatibleRoomInput,
        allowHostReturn: boolean,
    ): Promise<CoordinatorResult<RoomStatus>> {
        const room = resolveCompatibleRoom(input)
        if (!room) return roomNotFound()
        assertParticipant(input.participant, this.allowRemoteParticipants)
        if (hasViewerIdConflict(this.toRoomStatus(room).members, input.participant)) {
            return { ok: false, error: "VIEWER_ID_CONFLICT" }
        }
        const compatibility = this.checkRoomCompatibility(room, input.compatibility)
        if (!compatibility.ok) return compatibility
        // 房主的任何房间解析（搜索/准备/选择/恢复）都续命；客机轮询不续命。
        if (input.participant.viewerId === room.host_viewer_id) {
            updateHostEntryTime(room.room_number)
            if (allowHostReturn) {
                const hostIdentity = lifecycleRegistry.hostOf(room.room_number)
                if (hostIdentity !== undefined) {
                    // 房主返回流程（prepare/select）是 4→1 的唯一触发；未结算时内核闩锁。
                    lifecycleRegistry.dispatch(room.room_number, generation => ({
                        type: "hostReturn",
                        generation,
                        identity: hostIdentity,
                        nowMs: getRealNowMs(),
                    }))
                    reconcileHostReturn(room.room_number)
                }
            }
        }
        return ok(this.toRoomStatus(room))
    }

    private checkRoomCompatibility(
        room: MultiRoom,
        received: MultiCompatibilityProfile,
    ): CoordinatorResult<void> {
        assertCompatibility(received)
        const hostCompatibility = compatibilityByRoom.get(room) ?? EMBEDDED_COMPATIBILITY
        const comparison = compareCompatibility(hostCompatibility, received)
        if (!comparison.compatible) {
            this.onCompatibilityRejection?.({
                code: "INCOMPATIBLE_ROOM",
                differences: comparison.differences.map(difference => ({
                    field: difference.field,
                    required: difference.host,
                    received: difference.guest,
                })),
            })
            return { ok: false, error: "INCOMPATIBLE_ROOM" }
        }
        return ok(undefined)
    }

    private assertBattleInput(input: BattleSessionInput): void {
        assertParticipant(input.participant, this.allowRemoteParticipants)
        assertNonEmptyString(input.roomNumber, "roomNumber")
        assertNonEmptyString(input.battleSessionId as BattleSessionId, "battleSessionId")
    }

    private removeOwnedRoom(room: MultiRoom, hardClose = false): boolean {
        // 撤权（node session 失效）必须立即断，不能等 dismiss 兜底；
        // 正常解散走 manager.disbandRoom 的 dismiss-only。
        if (hardClose) {
            sessionManager.broadcastToRoom(room.room_number, [1, [6, "multibattle_room_dismissed"]])
            sessionManager.closeRoomClients(room.room_number)
        }
        if (!disbandLocalRoom(room.room_number)) return false
        this.onRoomDisband?.(room.room_number)
        compatibilityByRoom.delete(room)
        hostIdentityByRoom.delete(room)
        return true
    }

    private releaseIfFullyFinalized(status: BattleStatus): boolean {
        if (!sessionManager.isBattleFullyFinalized(status)) return false
        // R-01 守卫：retained 旧代 session（finish 重试授权窗口内）的迟到
        // finalize/leave/cleanup 不得释放已被新一代战斗占用的房间——那会把
        // raising_state 重置回 1 并清掉新局的 facts。active 映射为 null
        // （房间已回 Ready）时同样跳过：重复 finalize 的幂等由状态机拒绝
        // 1->1 兜底，无需重放 onBattleReleased。
        const activeSessionId = sessionManager.getActiveBattleSessionId(status.roomNumber)
        if (activeSessionId === null || activeSessionId !== status.battleSessionId) return false
        return this.releaseBattle(status.roomNumber, status.battleSessionId)
    }

    // Finish：只释座 + 清 facts/NPC 和 NPC 名册；4→1 只由 HostReturn 触发。
    // 房主在最后一个 finish 前已请求返回时，内核已 ready，这里立即补 4→1。
    private releaseBattle(roomNumber: string, battleSessionId?: string): boolean {
        const room = getRoom(roomNumber)
        if (!room) return false
        // 清 facts 前快照当前参战者：客机 abort 已从 map 移除的不会进入服务矩阵。
        const battleParticipants = sessionManager.getBattleParticipantsForRoom(roomNumber)
        sessionManager.clearBattleExpectedCount(roomNumber)
        // 一场一换挂点（设计 v2 §4）：release 是 finalize/abort 两路的唯一咽喉，
        // 且先于 host re-enter——NPC 编队清除必须发生在客户端重建视图之前。
        if (this.onBattleReleased) {
            try {
                this.onBattleReleased(roomNumber, battleSessionId)
            } catch (error) {
                console.warn(`[MULTI] onBattleReleased callback failed: room=${roomNumber}`, describeError(error))
            }
        }
        if (room.raising_state === 4) {
            // 座位与成员投影分离：seats 立即释放到房主；battle_participants
            // 留给 state 4 的服务矩阵，HostReturn 时清空。
            const serving = battleParticipants.length > 0
                ? battleParticipants
                : room.member_participants
            room.battle_participants = serving.map(member => ({ ...member }))
            room.member_participants = room.member_participants.filter(
                member => member.viewerId === room.host_viewer_id,
            )
        }
        reconcileHostReturn(roomNumber)
        return true
    }

    private removeInvalidatedRoomMembers(
        room: MultiRoom,
        nodeSessionId: NodeSessionId,
        invalidatedParticipants: readonly ParticipantIdentity[],
    ): boolean {
        const survivingViewerIds = new Set(sessionManager.getClientsInRoom(room.room_number)
            .filter(client => client.participant?.nodeSessionId !== nodeSessionId)
            .map(client => client.viewerId))
        const removedViewerIds = new Set<number>()
        for (const participant of invalidatedParticipants) {
            if (survivingViewerIds.has(participant.viewerId)) continue
            // 房主由 host 分支单独处理，永远不从自己的 mates 里删
            if (participant.viewerId === room.host_viewer_id) continue
            // 4→1 释座可能已经把成员簿清空，removeRoomMember 返回 false；
            // 仍要按 viewerId 清掉房间和宿主的 mates 投影，否则已失效客机
            // 会残留在注册行/大厅视图里（multi_hub_session_cleanup 红点）。
            removeRoomMember(room.room_number, participant)
            removedViewerIds.add(participant.viewerId)
        }
        if (removedViewerIds.size === 0) return false

        room.mates = room.mates.filter(mate => (
            mate.viewer_id === null || !removedViewerIds.has(mate.viewer_id)
        ))
        for (const client of sessionManager.getClientsInRoom(room.room_number)) {
            client.mates = client.mates.filter(mate => !removedViewerIds.has(mate.viewerId))
        }
        const hostClient = sessionManager.getRoomHostClient(room.room_number)
        if (hostClient) {
            sessionManager.broadcastToRoom(room.room_number, [1, [1, hostClient.mates]])
        }
        try {
            const { syncRoomShareRow } = require("../room/share-sync") as typeof import("../room/share-sync")
            syncRoomShareRow(room.room_number)
        } catch (error) {
            console.warn(`[MULTI] node cleanup share sync failed: room=${room.room_number}`, describeError(error))
        }
        return true
    }

    private warnNodeSessionCleanup(roomNumber: string): void {
        console.warn(`[MULTI] node session cleanup deferred for room ${roomNumber}`)
    }

    private toRoomStatus(room: MultiRoom): RoomStatus {
        const host = hostIdentityByRoom.get(room) ?? Object.freeze({
            nodeSessionId: EMBEDDED_NODE_SESSION_ID,
            viewerId: room.host_viewer_id,
        })
        const battleSessionId = sessionManager.getActiveBattleSessionId(room.room_number)
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
            members: Object.freeze((room.raising_state === 4 && room.battle_participants.length > 0
                ? room.battle_participants
                : room.member_participants).map(member => Object.freeze({
                nodeSessionId: member.nodeSessionId as NodeSessionId,
                viewerId: member.viewerId,
            }))),
            compatibility: compatibilityByRoom.get(room) ?? EMBEDDED_COMPATIBILITY,
            ...(battleSessionId === null ? {} : { battleSessionId }),
        })
    }
}
