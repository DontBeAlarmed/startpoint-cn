import type { IncomingHttpHeaders } from "node:http"

import { getQuestFromCategorySync } from "../../lib/assets"
import { getServerTime } from "../../utils"
import type { MultiPlayerContext } from "../player-context"
import { resolveMultiPlayerContext } from "../player-context"
import type { MultiCoordinator } from "../coordinator/interface"
import type {
    CoordinatorResult,
    MultiCompatibilityProfile,
    MultiCoordinatorOrigin,
    ParticipantIdentity,
} from "../coordinator/contracts"
import {
    isOriginAwareMultiCoordinator,
    type CoordinatorOriginLookup,
} from "../coordinator/router"
import {
    EMBEDDED_NODE_SESSION_ID,
    EmbeddedMultiCoordinator,
} from "../coordinator/embedded"
import {
    createCompatibilityProfileFactory,
    type CompatibilityProfileDependencies,
} from "../compatibility"
import {
    checkLocalQuestAvailability,
    type QuestAvailabilityResult,
} from "../quest-availability"
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
import type { RoomConnectionEndpoint } from "../room/serializer"
import { MultiSettlementVerifier } from "../settlement/verifier"
import { recordMultiCompatibilityRejection } from "../../lib/admin-multi-status"

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
    getCompatibility(headers: IncomingHttpHeaders): CoordinatorResult<MultiCompatibilityProfile>
    prepareAdmission(viewerId: number): Promise<PreparedAdmissionSnapshot | null>
}

export interface MultiQuestAvailabilityProvider {
    check(category: number, questId: number): QuestAvailabilityResult
}

export interface PreparedAdmissionSnapshot {
    readonly snapshot: PlayerSnapshot
}

export interface MultiHttpContext {
    readonly coordinator: MultiCoordinator
    readonly resolveCoordinatorOrigin: (
        input: CoordinatorOriginLookup,
    ) => Promise<MultiCoordinatorOrigin>
    readonly resolvePlayerContext: ResolveMultiPlayerContext
    readonly snapshotProvider: MultiSnapshotProvider
    readonly questAvailability: MultiQuestAvailabilityProvider
    readonly admissionProvider: AdmissionProvider
    readonly admissionIssuer: AdmissionIssuer
    readonly admissionTtlMs: number
    readonly now: () => number
    readonly settlementVerifier: MultiSettlementVerifier
    readonly tcpEndpoint?: () => RoomConnectionEndpoint | null
}

export interface EmbeddedMultiHttpContextOptions {
    readonly coordinator?: MultiCoordinator
    readonly coordinatorOrigin?: MultiCoordinatorOrigin
    readonly compatibility?: MultiCompatibilityProfile
    readonly compatibilityProfileDependencies?: CompatibilityProfileDependencies
    readonly resolvePlayerContext?: ResolveMultiPlayerContext
    readonly admissionRegistry?: AdmissionRegistry
    readonly admissionTtlMs?: number
    readonly now?: () => number
    readonly serverTimeMs?: () => number
    readonly prepareAdmission?: (
        viewerId: number,
    ) => Promise<PreparedAdmissionSnapshot | null>
    readonly tcpEndpoint?: () => RoomConnectionEndpoint | null
}

export function createEmbeddedMultiHttpContext(
    options: EmbeddedMultiHttpContextOptions = {},
): MultiHttpContext {
    const coordinator = options.coordinator ?? new EmbeddedMultiCoordinator()
    const coordinatorOrigin = options.coordinatorOrigin ?? "local"
    const resolvePlayerContext = options.resolvePlayerContext ?? resolveMultiPlayerContext
    const admissionRegistry = options.admissionRegistry ?? embeddedAdmissionRegistry
    const now = options.now ?? Date.now
    const fixedCompatibility = options.compatibility
        ? Object.freeze({ ...options.compatibility }) as MultiCompatibilityProfile
        : null
    const getCompatibility = fixedCompatibility
        ? () => ({
            ok: true as const,
            value: fixedCompatibility,
        })
        : createCompatibilityProfileFactory({
            ...options.compatibilityProfileDependencies,
            onCompatibilityRejection: options.compatibilityProfileDependencies
                ?.onCompatibilityRejection ?? recordMultiCompatibilityRejection,
        })
    const serverTimeMs = options.serverTimeMs ?? (() => getServerTime() * 1000)
    return Object.freeze({
        coordinator,
        resolveCoordinatorOrigin: (
            input: CoordinatorOriginLookup,
        ): Promise<MultiCoordinatorOrigin> => isOriginAwareMultiCoordinator(coordinator)
            ? coordinator.resolveOrigin(input)
            : Promise.resolve(coordinatorOrigin),
        resolvePlayerContext,
        snapshotProvider: Object.freeze({
            getParticipant: (viewerId: number) => ({
                nodeSessionId: EMBEDDED_NODE_SESSION_ID,
                viewerId,
            }),
            getCompatibility,
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
        questAvailability: Object.freeze({
            check: (category: number, questId: number) => {
                const quest = getQuestFromCategorySync(category, questId)
                return quest === null
                    ? { available: false as const, code: "QUEST_NOT_AVAILABLE" as const }
                    : checkLocalQuestAvailability(quest, category, serverTimeMs())
            },
        }),
        admissionProvider: admissionRegistry,
        admissionIssuer: admissionRegistry,
        admissionTtlMs: options.admissionTtlMs ?? DEFAULT_ADMISSION_TTL_MS,
        now,
        settlementVerifier: new MultiSettlementVerifier(coordinator),
        tcpEndpoint: options.tcpEndpoint,
    })
}
