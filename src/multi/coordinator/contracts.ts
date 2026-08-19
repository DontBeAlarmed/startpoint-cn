export const MULTI_PROTOCOL_VERSION = 1 as const

const MULTI_ROOM_NUMBER_PATTERN = /^[1-9]\d{5}$/
const BATTLE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type NodeSessionId = string & { readonly __nodeSessionId: unique symbol }
export type BattleSessionId = string & { readonly __battleSessionId: unique symbol }
export type MultiCoordinatorOrigin = "remote" | "local"

/** Used only before a client-side Hub call obtains its current session identity. */
export const REMOTE_PENDING_NODE_SESSION_ID = "remote-pending" as NodeSessionId

export interface ParticipantIdentity {
    readonly nodeSessionId: NodeSessionId
    readonly viewerId: number
}

export interface MultiCompatibilityProfile {
    readonly multiProtocolVersion: typeof MULTI_PROTOCOL_VERSION
    readonly APP_VER: string
    readonly RES_VER: string
    readonly cdnTargetVersion: string
    readonly contentDigest: `sha256:${string}`
    readonly modeDigest: `sha256:${string}`
}

export type CoordinatorErrorCode =
    | "INCOMPATIBLE_ROOM"
    | "VIEWER_ID_CONFLICT"
    | "QUEST_NOT_AVAILABLE"
    | "ROOM_PERMISSION_DENIED"
    | "ROOM_NOT_FOUND"
    | "HUB_UNAVAILABLE"

export type CoordinatorResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: CoordinatorErrorCode }

export function isValidMultiRoomNumber(value: unknown): value is string {
    return typeof value === "string" && MULTI_ROOM_NUMBER_PATTERN.test(value)
}

export function isValidBattleSessionId(value: unknown): value is string {
    return typeof value === "string" && BATTLE_SESSION_ID_PATTERN.test(value)
}

export function participantKey(nodeSessionId: NodeSessionId, viewerId: number): string {
    if (!nodeSessionId || !Number.isSafeInteger(viewerId) || viewerId <= 0) {
        throw new TypeError("invalid multi participant identity")
    }
    return `${nodeSessionId}:${viewerId}`
}

export function hasViewerIdConflict(
    members: readonly ParticipantIdentity[],
    candidate: ParticipantIdentity,
): boolean {
    return members.some(member => (
        member.viewerId === candidate.viewerId
        && member.nodeSessionId !== candidate.nodeSessionId
    ))
}
