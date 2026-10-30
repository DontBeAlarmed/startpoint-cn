import type { CoordinatorErrorCode, ParticipantIdentity } from "../coordinator/contracts"
import type { PlayerSnapshot } from "../snapshot/player-snapshot"
import { getRoom, getRoomOccupiedMemberCount, isRoomViewerMember } from "../room/manager"
import { lifecycleRegistry } from "../lifecycle"
import { getRealNowMs } from "../../runtime/time/game-time"

const MAX_REAL_ROOM_MEMBERS = 3

export interface RoomAdmission {
    readonly roomNumber: string
    readonly participant: ParticipantIdentity
    readonly snapshot: PlayerSnapshot
    readonly expiresAt: number
    /** 签发时的房间代次；握手把它绑定到 SessionClient，旧代次事件被内核丢弃。 */
    readonly lifecycleGeneration?: number
}

export interface AdmissionProvider {
    consume(roomNumber: string, viewerId: number): RoomAdmission | null
    release?(roomNumber: string, viewerId: number): boolean
}

export interface AdmissionIssuer {
    issue(input: AdmissionIssueInput): AdmissionIssueResult | Promise<AdmissionIssueResult>
}

export type AdmissionIssueInput = RoomAdmission

export type AdmissionIssueResult =
    | { readonly ok: true, readonly value: RoomAdmission }
    | { readonly ok: false, readonly error: CoordinatorErrorCode }

export interface AdmissionRegistryOptions {
    readonly now?: () => number
    readonly getOccupiedMemberCount?: (roomNumber: string) => number
    readonly isOccupiedMember?: (roomNumber: string, viewerId: number) => boolean
    /** 房间所属节点权威代次；远程节点签发的票不带本地 registry，由 owner 补齐。 */
    readonly resolveLifecycleGeneration?: (roomNumber: string) => number | undefined
}

function normalizeRoomNumber(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null
}

function isValidViewerId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function key(roomNumber: string, viewerId: number): string {
    return `${roomNumber}\0${viewerId}`
}

export class AdmissionRegistry implements AdmissionProvider, AdmissionIssuer {
    private readonly admissions = new Map<string, RoomAdmission>()
    private readonly now: () => number
    private readonly getOccupiedMemberCount: (roomNumber: string) => number
    private readonly isOccupiedMember: (roomNumber: string, viewerId: number) => boolean
    private readonly resolveLifecycleGeneration: (roomNumber: string) => number | undefined

    constructor(options: AdmissionRegistryOptions = {}) {
        this.now = options.now ?? getRealNowMs
        this.getOccupiedMemberCount = options.getOccupiedMemberCount ?? (() => 0)
        this.isOccupiedMember = options.isOccupiedMember ?? (() => false)
        this.resolveLifecycleGeneration = options.resolveLifecycleGeneration
            ?? (roomNumber => lifecycleRegistry.get(roomNumber)?.generation)
    }

    issue(input: AdmissionIssueInput): AdmissionIssueResult {
        const roomNumber = normalizeRoomNumber(input?.roomNumber)
        if (!roomNumber) throw new TypeError("roomNumber must be a non-empty string")
        if (!isValidViewerId(input?.participant?.viewerId)) {
            throw new TypeError("participant.viewerId must be a positive safe integer")
        }
        if (typeof input.participant.nodeSessionId !== "string"
            || input.participant.nodeSessionId.trim().length === 0) {
            throw new TypeError("participant.nodeSessionId must be a non-empty string")
        }
        if (input.snapshot?.viewerId !== input.participant.viewerId) {
            throw new TypeError("snapshot viewer must match participant viewer")
        }
        const now = this.now()
        if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
            throw new TypeError("expiresAt must be a future safe integer")
        }
        this.cleanup()
        const admissionKey = key(roomNumber, input.participant.viewerId)
        // owner registry 是代次权威：远程节点签发的票只有 participant/snapshot，
        // 在这里补上本节点代次；本节点缺失时才退回票面值。
        const lifecycleGeneration = this.resolveLifecycleGeneration(roomNumber)
            ?? input.lifecycleGeneration
        const existing = this.admissions.get(admissionKey)
        if (existing) {
            if (existing.participant.nodeSessionId !== input.participant.nodeSessionId) {
                return { ok: false, error: "VIEWER_ID_CONFLICT" }
            }
            if (lifecycleGeneration !== undefined
                && existing.lifecycleGeneration !== lifecycleGeneration) {
                // 重发票刷新代次（及随票快照/有效期），避免房号复用后旧票
                // 把旧代次、过期快照带进新房间。
                const refreshed = Object.freeze({
                    ...existing,
                    snapshot: input.snapshot,
                    expiresAt: input.expiresAt,
                    lifecycleGeneration,
                }) as RoomAdmission
                this.admissions.set(admissionKey, refreshed)
                return { ok: true, value: refreshed }
            }
            return { ok: true, value: existing }
        }

        const pendingMemberCount = [...this.admissions.values()]
            .filter(admission => admission.roomNumber === roomNumber
                && !this.isOccupiedMember(roomNumber, admission.participant.viewerId))
            .length
        // 占座成员重发入场票=收回自己座位（豁免）：战斗中/后大厅 socket 关闭
        // 不改成员簿，返回成员的 occupied 身份仍在——无豁免会被自己的座位
        // 顶成满员（2026-10-30 真机复现：房主+两客机返回全部被拒）。
        // pending 票=预占座（持有者 Enter 转正），occupied+pending 达到容量即拒：
        // 官服实测（2026-10-30）：结算后房主先回、D 抢位、B/C 后回被满员拒——
        // 逐账验证 `>=` 精确复现（第 3 张票入座后房间即满，第 4 张拒绝）
        if (!this.isOccupiedMember(roomNumber, input.participant.viewerId)
            && this.getOccupiedMemberCount(roomNumber) + pendingMemberCount >= MAX_REAL_ROOM_MEMBERS) {
            return { ok: false, error: "ROOM_FULL" }
        }

        const admission = {
            roomNumber,
            participant: Object.freeze({ ...input.participant }),
            snapshot: input.snapshot,
            expiresAt: input.expiresAt,
            ...(lifecycleGeneration !== undefined
                ? { lifecycleGeneration }
                : {}),
        }
        Object.freeze(admission)
        this.admissions.set(admissionKey, admission)
        return { ok: true, value: admission }
    }

    consume(roomNumber: string, viewerId: number): RoomAdmission | null {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber)
        if (!normalizedRoomNumber || !isValidViewerId(viewerId)) return null

        const admissionKey = key(normalizedRoomNumber, viewerId)
        const admission = this.admissions.get(admissionKey)
        if (!admission) return null
        if (admission.expiresAt <= this.now()) {
            this.admissions.delete(admissionKey)
            return null
        }
        this.admissions.delete(admissionKey)
        return admission
    }

    release(roomNumber: string, viewerId: number): boolean {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber)
        if (!normalizedRoomNumber || !isValidViewerId(viewerId)) return false
        return this.admissions.delete(key(normalizedRoomNumber, viewerId))
    }

    clearRoom(roomNumber: string): number {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber)
        if (!normalizedRoomNumber) return 0
        let removed = 0
        for (const [admissionKey, admission] of this.admissions) {
            if (admission.roomNumber !== normalizedRoomNumber) continue
            this.admissions.delete(admissionKey)
            removed++
        }
        return removed
    }

    cleanup(): number {
        const now = this.now()
        let removed = 0
        for (const [admissionKey, admission] of this.admissions) {
            if (admission.expiresAt > now) continue
            this.admissions.delete(admissionKey)
            removed++
        }
        return removed
    }

    removeByNodeSession(nodeSessionId: string): number {
        let removed = 0
        for (const [admissionKey, admission] of this.admissions) {
            if (admission.participant.nodeSessionId !== nodeSessionId) continue
            this.admissions.delete(admissionKey)
            removed++
        }
        return removed
    }
}

export const embeddedAdmissionRegistry = new AdmissionRegistry({
    getOccupiedMemberCount: getRoomOccupiedMemberCount,
    isOccupiedMember: (roomNumber, viewerId) => {
        const room = getRoom(roomNumber)
        return room !== undefined && isRoomViewerMember(room, viewerId)
    },
})
