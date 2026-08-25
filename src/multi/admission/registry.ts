import type { CoordinatorErrorCode, ParticipantIdentity } from "../coordinator/contracts"
import type { PlayerSnapshot } from "../snapshot/player-snapshot"
import { getRoom, getRoomOccupiedMemberCount, isRoomViewerMember } from "../room/manager"

const MAX_REAL_ROOM_MEMBERS = 3

export interface RoomAdmission {
    readonly roomNumber: string
    readonly participant: ParticipantIdentity
    readonly snapshot: PlayerSnapshot
    readonly expiresAt: number
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

    constructor(options: AdmissionRegistryOptions = {}) {
        this.now = options.now ?? Date.now
        this.getOccupiedMemberCount = options.getOccupiedMemberCount ?? (() => 0)
        this.isOccupiedMember = options.isOccupiedMember ?? (() => false)
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
        const existing = this.admissions.get(admissionKey)
        if (existing) {
            if (existing.participant.nodeSessionId !== input.participant.nodeSessionId) {
                return { ok: false, error: "VIEWER_ID_CONFLICT" }
            }
            return { ok: true, value: existing }
        }

        const pendingMemberCount = [...this.admissions.values()]
            .filter(admission => admission.roomNumber === roomNumber
                && !this.isOccupiedMember(roomNumber, admission.participant.viewerId))
            .length
        if (this.getOccupiedMemberCount(roomNumber) + pendingMemberCount >= MAX_REAL_ROOM_MEMBERS) {
            return { ok: false, error: "ROOM_FULL" }
        }

        const admission = {
            roomNumber,
            participant: Object.freeze({ ...input.participant }),
            snapshot: input.snapshot,
            expiresAt: input.expiresAt,
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
