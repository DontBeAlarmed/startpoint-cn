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
import {
    embeddedAdmissionRegistry,
    type AdmissionIssuer,
    type AdmissionProvider,
    type AdmissionRegistry,
} from "../admission/registry"
import {
    buildPlayerSnapshot,
    type PlayerSnapshot,
} from "../snapshot/player-snapshot"

export const DEFAULT_ADMISSION_TTL_MS = 15_000

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
    prepareAdmission(viewerId: number): Promise<PreparedAdmissionSnapshot | null>
}

export interface PreparedAdmissionSnapshot {
    readonly snapshot: PlayerSnapshot
}

export interface MultiSettlementVerifier {
    getBattleStatus(input: BattleSessionInput): Promise<CoordinatorResult<BattleStatus>>
}

export interface MultiHttpContext {
    readonly coordinator: MultiCoordinator
    readonly resolvePlayerContext: ResolveMultiPlayerContext
    readonly snapshotProvider: MultiSnapshotProvider
    readonly admissionProvider: AdmissionProvider
    readonly admissionIssuer: AdmissionIssuer
    readonly admissionTtlMs: number
    readonly now: () => number
    readonly settlementVerifier: MultiSettlementVerifier
}

export interface EmbeddedMultiHttpContextOptions {
    readonly compatibility?: MultiCompatibilityProfile
    readonly resolvePlayerContext?: ResolveMultiPlayerContext
    readonly admissionRegistry?: AdmissionRegistry
    readonly admissionTtlMs?: number
    readonly now?: () => number
    readonly prepareAdmission?: (
        viewerId: number,
    ) => Promise<PreparedAdmissionSnapshot | null>
}

export function createEmbeddedMultiHttpContext(
    options: EmbeddedMultiHttpContextOptions = {},
): MultiHttpContext {
    const coordinator = new EmbeddedMultiCoordinator()
    const resolvePlayerContext = options.resolvePlayerContext ?? resolveMultiPlayerContext
    const admissionRegistry = options.admissionRegistry ?? embeddedAdmissionRegistry
    const now = options.now ?? Date.now
    const compatibility = Object.freeze({
        ...(options.compatibility ?? EMBEDDED_COMPATIBILITY),
    })
    return Object.freeze({
        coordinator,
        resolvePlayerContext,
        snapshotProvider: Object.freeze({
            getParticipant: (viewerId: number) => ({
                nodeSessionId: EMBEDDED_NODE_SESSION_ID,
                viewerId,
            }),
            getCompatibility: async (_viewerId: number) => compatibility,
            prepareAdmission: options.prepareAdmission ?? (async (viewerId: number) => {
                const context = await resolvePlayerContext(viewerId)
                if (!context) return null
                const snapshot = await buildPlayerSnapshot(
                    viewerId,
                    context.player.partySlot,
                    { resolvePlayerContext: async () => context },
                )
                return snapshot ? { snapshot } : null
            }),
        }),
        admissionProvider: admissionRegistry,
        admissionIssuer: admissionRegistry,
        admissionTtlMs: options.admissionTtlMs ?? DEFAULT_ADMISSION_TTL_MS,
        now,
        settlementVerifier: Object.freeze({
            getBattleStatus: (input: BattleSessionInput) => coordinator.getBattleStatus(input),
        }),
    })
}
