export const MULTI_PROTOCOL_VERSION = 1 as const

export type NodeSessionId = string & { readonly __nodeSessionId: unique symbol }
export type BattleSessionId = string & { readonly __battleSessionId: unique symbol }

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
