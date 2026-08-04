export const MULTI_PROTOCOL_VERSION = 1 as const

export type NodeSessionId = string & { readonly __nodeSessionId: unique symbol }
export type BattleSessionId = string & { readonly __battleSessionId: unique symbol }

export interface ParticipantIdentity {
    readonly nodeSessionId: NodeSessionId
    readonly viewerId: number
}

export interface MultiCompatibilityProfile {
    readonly protocolVersion: number
    readonly appVersion: string
    readonly resourceVersion: string
    readonly cdnTargetVersion: string
    readonly contentDigest: string
    readonly modeDigest: string
}

export type CoordinatorErrorCode =
    | "INCOMPATIBLE_ROOM"
    | "VIEWER_ID_CONFLICT"
    | "QUEST_NOT_AVAILABLE"
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
