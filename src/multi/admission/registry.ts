import type { ParticipantIdentity } from "../coordinator/contracts"
import type { PlayerSnapshot } from "../snapshot/player-snapshot"

export interface RoomAdmission {
    readonly roomNumber: string
    readonly participant: ParticipantIdentity
    readonly snapshot: PlayerSnapshot
    readonly expiresAt: number
}

export interface AdmissionProvider {
    consume(roomNumber: string, viewerId: number): RoomAdmission | null
}

export interface AdmissionIssuer {
    issue(input: AdmissionIssueInput): AdmissionIssueResult
}

export interface EmbeddedAdmissionMetadata {
    readonly localPlayerId: number
}

export interface AdmissionIssueInput extends RoomAdmission {
    readonly embedded?: EmbeddedAdmissionMetadata
}

export type AdmissionIssueResult =
    | { readonly ok: true, readonly value: RoomAdmission }
    | { readonly ok: false, readonly error: "VIEWER_ID_CONFLICT" }

export interface AdmissionRegistryOptions {
    readonly now?: () => number
}

const embeddedMetadata = Symbol("embeddedAdmissionMetadata")
type InternalAdmission = RoomAdmission & {
    readonly [embeddedMetadata]?: EmbeddedAdmissionMetadata
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

export function getEmbeddedAdmissionMetadata(
    admission: RoomAdmission | null,
): EmbeddedAdmissionMetadata | null {
    return admission
        ? (admission as InternalAdmission)[embeddedMetadata] ?? null
        : null
}

export class AdmissionRegistry implements AdmissionProvider, AdmissionIssuer {
    private readonly admissions = new Map<string, InternalAdmission>()
    private readonly now: () => number

    constructor(options: AdmissionRegistryOptions = {}) {
        this.now = options.now ?? Date.now
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
        if (input.embedded !== undefined
            && !isValidViewerId(input.embedded.localPlayerId)) {
            throw new TypeError("embedded.localPlayerId must be a positive safe integer")
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

        const admission = {
            roomNumber,
            participant: Object.freeze({ ...input.participant }),
            snapshot: input.snapshot,
            expiresAt: input.expiresAt,
        } as InternalAdmission
        if (input.embedded !== undefined) {
            Object.defineProperty(admission, embeddedMetadata, {
                value: Object.freeze({ ...input.embedded }),
                enumerable: false,
            })
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
}

export const embeddedAdmissionRegistry = new AdmissionRegistry()
