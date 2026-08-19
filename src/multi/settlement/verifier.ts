import type {
    BattleSessionId,
    MultiCoordinatorOrigin,
    NodeSessionId,
    ParticipantIdentity,
} from "../coordinator/contracts"
import {
    participantKey,
    REMOTE_PENDING_NODE_SESSION_ID,
} from "../coordinator/contracts"
import type { MultiCoordinator } from "../coordinator/interface"

export interface MultiSettlementIdentity {
    readonly nodeSessionId: NodeSessionId
    readonly viewerId: number
    readonly roomNumber: string
    readonly battleSessionId: string
    readonly coordinatorOrigin: MultiCoordinatorOrigin
}

export type MultiSettlementVerification =
    | { readonly ok: true; readonly isHost: boolean }
    | { readonly ok: false }

export type MultiBattleRecoveryInspection =
    | { readonly state: "active" }
    | { readonly state: "finalized" }
    | { readonly state: "missing" }
    | { readonly state: "unavailable"; readonly code: "HUB_UNAVAILABLE" }

export class MultiSettlementVerifier {
    constructor(
        private readonly coordinator: Pick<MultiCoordinator, "getBattleStatus">,
    ) {}

    async inspect(input: MultiSettlementIdentity): Promise<MultiBattleRecoveryInspection> {
        if (!isValidIdentity(input)) return unavailable()
        try {
            const result = await this.coordinatorFor(input.coordinatorOrigin).getBattleStatus({
                participant: {
                    nodeSessionId: input.nodeSessionId,
                    viewerId: input.viewerId,
                },
                roomNumber: input.roomNumber,
                battleSessionId: input.battleSessionId as BattleSessionId,
            })
            if (!result.ok) {
                return result.error === "ROOM_NOT_FOUND"
                    ? { state: "missing" }
                    : unavailable()
            }
            if (result.value.roomNumber !== input.roomNumber
                || result.value.battleSessionId !== input.battleSessionId
                || resolveParticipant(result.value.participants, input) === null) {
                return unavailable()
            }
            return { state: result.value.finalized ? "finalized" : "active" }
        } catch {
            return unavailable()
        }
    }

    async verify(input: MultiSettlementIdentity): Promise<MultiSettlementVerification> {
        if (input.battleSessionId.trim().length === 0) return { ok: false }
        const participant = {
            nodeSessionId: input.nodeSessionId,
            viewerId: input.viewerId,
        }
        try {
            const result = await this.coordinatorFor(input.coordinatorOrigin).getBattleStatus({
                participant,
                roomNumber: input.roomNumber,
                battleSessionId: input.battleSessionId as BattleSessionId,
            })
            if (!result.ok
                || !result.value.finalized
                || result.value.roomNumber !== input.roomNumber
                || result.value.battleSessionId !== input.battleSessionId) {
                return { ok: false }
            }
            const resolvedParticipant = resolveParticipant(result.value.participants, input)
            if (resolvedParticipant === null) {
                return { ok: false }
            }
            return {
                ok: true,
                isHost: participantKey(
                    result.value.host.nodeSessionId,
                    result.value.host.viewerId,
                ) === participantKey(
                    resolvedParticipant.nodeSessionId,
                    resolvedParticipant.viewerId,
                ),
            }
        } catch {
            return { ok: false }
        }
    }

    private coordinatorFor(
        origin: MultiCoordinatorOrigin,
    ): Pick<MultiCoordinator, "getBattleStatus"> {
        const candidate = this.coordinator as Pick<MultiCoordinator, "getBattleStatus"> & {
            coordinatorFor?: (
                coordinatorOrigin: MultiCoordinatorOrigin,
            ) => Pick<MultiCoordinator, "getBattleStatus">
        }
        return (origin === "remote" || origin === "local")
            && typeof candidate.coordinatorFor === "function"
            ? candidate.coordinatorFor(origin)
            : this.coordinator
    }
}

function isValidIdentity(input: MultiSettlementIdentity): boolean {
    return typeof input.nodeSessionId === "string"
        && input.nodeSessionId.trim().length > 0
        && Number.isSafeInteger(input.viewerId)
        && input.viewerId > 0
        && typeof input.roomNumber === "string"
        && input.roomNumber.trim().length > 0
        && typeof input.battleSessionId === "string"
        && input.battleSessionId.trim().length > 0
}

function resolveParticipant(
    participants: readonly ParticipantIdentity[],
    input: MultiSettlementIdentity,
): ParticipantIdentity | null {
    const candidates = input.nodeSessionId === REMOTE_PENDING_NODE_SESSION_ID
        ? participants.filter(candidate => candidate.viewerId === input.viewerId)
        : participants.filter(candidate => participantKey(
            candidate.nodeSessionId,
            candidate.viewerId,
        ) === participantKey(input.nodeSessionId, input.viewerId))
    return candidates.length === 1 ? candidates[0] : null
}

function unavailable(): MultiBattleRecoveryInspection {
    return { state: "unavailable", code: "HUB_UNAVAILABLE" }
}
