import type { MultiPlayerContext } from "../player-context"
import { resolveMultiPlayerContext } from "../player-context"
import type {
    BattleSessionInput,
    BattleStatus,
    MultiCoordinator,
} from "../coordinator/interface"
import type {
    CoordinatorResult,
    MultiCompatibilityProfile,
    ParticipantIdentity,
} from "../coordinator/contracts"
import {
    EMBEDDED_COMPATIBILITY,
    EMBEDDED_NODE_SESSION_ID,
    EmbeddedMultiCoordinator,
} from "../coordinator/embedded"

export type ResolveMultiPlayerContext = (
    viewerId: number,
) => Promise<MultiPlayerContext | null>

export function isValidMultiViewerId(viewerId: unknown): viewerId is number {
    return typeof viewerId === "number"
        && Number.isSafeInteger(viewerId)
        && viewerId > 0
}

export interface MultiSnapshotProvider {
    getParticipant(viewerId: number): ParticipantIdentity
    getCompatibility(viewerId: number): Promise<MultiCompatibilityProfile>
}

export interface MultiSettlementVerifier {
    getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>>
}

export interface MultiHttpContext {
    readonly coordinator: MultiCoordinator
    readonly resolvePlayerContext: ResolveMultiPlayerContext
    readonly snapshotProvider: MultiSnapshotProvider
    readonly settlementVerifier: MultiSettlementVerifier
}

export interface EmbeddedMultiHttpContextOptions {
    readonly compatibility?: MultiCompatibilityProfile
    readonly resolvePlayerContext?: ResolveMultiPlayerContext
}

export function createEmbeddedMultiHttpContext(
    options: EmbeddedMultiHttpContextOptions = {},
): MultiHttpContext {
    const coordinator = new EmbeddedMultiCoordinator()
    const compatibility = Object.freeze({
        ...(options.compatibility ?? EMBEDDED_COMPATIBILITY),
    })
    return Object.freeze({
        coordinator,
        resolvePlayerContext: options.resolvePlayerContext ?? resolveMultiPlayerContext,
        snapshotProvider: Object.freeze({
            getParticipant: (viewerId: number) => ({
                nodeSessionId: EMBEDDED_NODE_SESSION_ID,
                viewerId,
            }),
            getCompatibility: async (_viewerId: number) => compatibility,
        }),
        settlementVerifier: Object.freeze({
            getBattleStatus: (input: BattleSessionInput) => coordinator.getBattleStatus(input),
        }),
    })
}
