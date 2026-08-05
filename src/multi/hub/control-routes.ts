import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
} from "fastify"

import type { AdmissionIssuer } from "../admission/registry"
import {
    MULTI_PROTOCOL_VERSION,
    type CoordinatorErrorCode,
    type ParticipantIdentity,
} from "../coordinator/contracts"
import type { MultiCoordinator } from "../coordinator/interface"
import type { CredentialReloader } from "./credential-reloader"
import {
    type CachedJsonResponse,
    type IdempotencyCache,
    isValidIdempotencyKey,
} from "./idempotency"
import type { NodeSession, NodeSessionRegistry } from "./node-sessions"
import type {
    CompatibilityRejectionDifference,
    CompatibilityRejectionSummary,
} from "../../lib/admin-multi-status"
import { sanitizeDiagnosticVersion } from "../../lib/diagnostic-version"

const COORDINATOR_ERRORS = new Set<CoordinatorErrorCode>([
    "INCOMPATIBLE_ROOM",
    "VIEWER_ID_CONFLICT",
    "QUEST_NOT_AVAILABLE",
    "ROOM_PERMISSION_DENIED",
    "ROOM_NOT_FOUND",
    "HUB_UNAVAILABLE",
])
const MAX_COMPATIBILITY_DIFFERENCES = 6
const COMPATIBILITY_FIELDS = new Set([
    "multiProtocolVersion",
    "APP_VER",
    "RES_VER",
    "cdnTargetVersion",
    "contentDigest",
    "modeDigest",
])
const VERSION_VALUE_FIELDS = new Set(["APP_VER", "RES_VER", "cdnTargetVersion"])

export interface MultiHubTcpEndpoint {
    readonly host: string
    readonly port: number
}

export interface MultiHubAuthorityDiagnostics {
    readonly activeRooms: number
    readonly activeBattleFacts: number
    readonly finalizedBattleFacts: number
    readonly latestCompatibilityRejection: CompatibilityRejectionSummary | null
}

export interface MultiHubControlStatus {
    readonly activeNodeSessions: number
    readonly enabledCredentials: number
    readonly activeRooms?: number
    readonly activeBattleFacts?: number
    readonly finalizedBattleFacts?: number
    readonly latestCompatibilityRejection?: CompatibilityRejectionSummary | null
}

export interface MultiHubControlRoutesOptions {
    readonly coordinator: MultiCoordinator
    readonly credentialReloader: CredentialReloader
    readonly nodeSessions: NodeSessionRegistry
    readonly admissionIssuer: AdmissionIssuer
    readonly idempotency: IdempotencyCache
    readonly tcpEndpoint: MultiHubTcpEndpoint
    readonly getDiagnostics?: () => MultiHubAuthorityDiagnostics
}

type ControlOperation = (input: any) => Promise<unknown> | unknown

function response(statusCode: number, body: unknown): CachedJsonResponse {
    return Object.freeze({ statusCode, body: JSON.stringify(body) })
}

function send(reply: FastifyReply, result: CachedJsonResponse): FastifyReply {
    return reply
        .status(result.statusCode)
        .header("content-type", "application/json; charset=utf-8")
        .send(result.body)
}

function bearer(request: FastifyRequest): string | null {
    const authorization = request.headers.authorization
    if (typeof authorization !== "string") return null
    const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(authorization)
    return match?.[1] ?? null
}

function authenticate(
    request: FastifyRequest,
    sessions: NodeSessionRegistry,
): NodeSession | null {
    const nodeSessionId = request.headers["x-node-session-id"]
    const sessionCredential = bearer(request)
    if (typeof nodeSessionId !== "string" || sessionCredential === null) return null
    return sessions.authenticate(nodeSessionId, sessionCredential)
}

function bindParticipant(input: unknown, session: NodeSession): Record<string, unknown> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("invalid control input")
    }
    const record = input as Record<string, unknown>
    const participant = record.participant as Partial<ParticipantIdentity> | undefined
    if (!Number.isSafeInteger(participant?.viewerId) || (participant?.viewerId ?? 0) <= 0) {
        throw new TypeError("invalid participant")
    }
    return {
        ...record,
        credentialId: session.credentialId,
        participant: Object.freeze({
            nodeSessionId: session.nodeSessionId,
            viewerId: participant?.viewerId,
        }),
    }
}

function normalizeResult(result: unknown): CachedJsonResponse {
    if (result === null || typeof result !== "object") return response(503, {
        ok: false,
        code: "HUB_UNAVAILABLE",
    })
    const value = result as { ok?: unknown; value?: unknown; error?: unknown }
    if (value.ok === true) return response(200, { ok: true, value: value.value })
    if (value.ok === false && COORDINATOR_ERRORS.has(value.error as CoordinatorErrorCode)) {
        return response(200, { ok: false, code: value.error })
    }
    return response(503, { ok: false, code: "HUB_UNAVAILABLE" })
}

function projectCompatibilityRejection(value: unknown): CompatibilityRejectionSummary | null {
    if (!isRecord(value)
        || value.code !== "INCOMPATIBLE_ROOM"
        || !Array.isArray(value.differences)
        || typeof value.timestamp !== "string") return null
    const timestamp = new Date(value.timestamp)
    if (!Number.isFinite(timestamp.getTime())) return null

    const differences: CompatibilityRejectionDifference[] = []
    for (const candidate of value.differences) {
        if (differences.length >= MAX_COMPATIBILITY_DIFFERENCES) break
        if (!isRecord(candidate)
            || typeof candidate.field !== "string"
            || !COMPATIBILITY_FIELDS.has(candidate.field)) continue
        const difference: {
            field: string
            different: true
            required?: string
            received?: string
        } = {
            field: candidate.field,
            different: true,
        }
        if (VERSION_VALUE_FIELDS.has(candidate.field)) {
            const required = sanitizeDiagnosticVersion(candidate.required)
            const received = sanitizeDiagnosticVersion(candidate.received)
            if (required !== null && received !== null) {
                difference.required = required
                difference.received = received
            }
        }
        differences.push(Object.freeze(difference))
    }
    return Object.freeze({
        code: "INCOMPATIBLE_ROOM",
        differences: Object.freeze(differences),
        timestamp: timestamp.toISOString(),
    })
}

function projectAuthorityDiagnostics(value: unknown): MultiHubAuthorityDiagnostics | null {
    if (!isRecord(value)
        || !isNonNegativeInteger(value.activeRooms)
        || !isNonNegativeInteger(value.activeBattleFacts)
        || !isNonNegativeInteger(value.finalizedBattleFacts)) return null
    return Object.freeze({
        activeRooms: value.activeRooms,
        activeBattleFacts: value.activeBattleFacts,
        finalizedBattleFacts: value.finalizedBattleFacts,
        latestCompatibilityRejection: projectCompatibilityRejection(
            value.latestCompatibilityRejection,
        ),
    })
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function invoke(operation: ControlOperation, input: unknown, session: NodeSession) {
    try {
        return normalizeResult(await operation(bindParticipant(input, session)))
    } catch (error) {
        return error instanceof TypeError
            ? response(400, { ok: false, code: "INVALID_REQUEST" })
            : response(503, { ok: false, code: "HUB_UNAVAILABLE" })
    }
}

function registerOperation(
    app: FastifyInstance,
    options: MultiHubControlRoutesOptions,
    route: string,
    name: string,
    write: boolean,
    operation: ControlOperation,
): void {
    app.post(route, async (request, reply) => {
        const session = authenticate(request, options.nodeSessions)
        if (session === null) return send(reply, response(401, {
            ok: false,
            code: "UNAUTHORIZED",
        }))
        if (!write) return send(reply, await invoke(operation, request.body, session))

        const idempotencyKey = request.headers["x-idempotency-key"]
        if (!isValidIdempotencyKey(idempotencyKey)) return send(reply, response(400, {
            ok: false,
            code: "INVALID_IDEMPOTENCY_KEY",
        }))
        try {
            const result = await options.idempotency.execute(
                session.nodeSessionId,
                name,
                idempotencyKey,
                () => invoke(operation, request.body, session),
            )
            return send(reply, result)
        } catch {
            return send(reply, response(503, { ok: false, code: "HUB_UNAVAILABLE" }))
        }
    })
}

export function registerMultiHubControlRoutes(
    app: FastifyInstance,
    options: MultiHubControlRoutesOptions,
): void {
    app.post("/v1/multi/nodes/register", async (request, reply) => {
        const token = bearer(request)
        const payload = request.body as { protocolVersion?: unknown } | null
        if (token === null || payload?.protocolVersion !== MULTI_PROTOCOL_VERSION) {
            return send(reply, response(401, { ok: false, code: "UNAUTHORIZED" }))
        }
        const credential = options.credentialReloader.authenticate(token)
        if (credential === null) {
            return send(reply, response(401, { ok: false, code: "UNAUTHORIZED" }))
        }
        try {
            const registration = options.nodeSessions.register(
                credential.credentialId,
                MULTI_PROTOCOL_VERSION,
            )
            return reply.status(200).send({
                ...registration,
                tcp: options.tcpEndpoint,
            })
        } catch {
            return send(reply, response(401, { ok: false, code: "UNAUTHORIZED" }))
        }
    })

    registerOperation(app, options, "/v1/multi/rooms/create", "rooms.create", true,
        input => options.coordinator.createRoom(input))
    registerOperation(app, options, "/v1/multi/rooms/search", "rooms.search", false,
        input => options.coordinator.searchRoom(input))
    registerOperation(app, options, "/v1/multi/rooms/prepare", "rooms.prepare", true,
        input => options.coordinator.prepareRoom(input))
    registerOperation(app, options, "/v1/multi/rooms/select", "rooms.select", false,
        input => options.coordinator.selectRoom(input))
    registerOperation(app, options, "/v1/multi/rooms/disband", "rooms.disband", true,
        input => options.coordinator.disbandRoom(input))
    registerOperation(app, options, "/v1/multi/rooms/status", "rooms.status", false,
        input => options.coordinator.getRoomStatus(input))
    registerOperation(app, options, "/v1/multi/battles/start", "battles.start", true,
        input => options.coordinator.startBattle(input))
    registerOperation(app, options, "/v1/multi/battles/abort", "battles.abort", true,
        input => options.coordinator.abortBattle(input))
    registerOperation(app, options, "/v1/multi/battles/finalize", "battles.finalize", true,
        input => options.coordinator.finalizeBattle(input))
    registerOperation(app, options, "/v1/multi/battles/status", "battles.status", false,
        input => options.coordinator.getBattleStatus(input))
    registerOperation(app, options, "/v1/multi/admissions/issue", "admissions.issue", true,
        input => options.admissionIssuer.issue(input))

    app.get("/v1/multi/status", async (request, reply) => {
        if (authenticate(request, options.nodeSessions) === null) {
            return send(reply, response(401, { ok: false, code: "UNAUTHORIZED" }))
        }
        const diagnostics = projectAuthorityDiagnostics(options.getDiagnostics?.())
        const value = diagnostics === null ? {
            activeNodeSessions: options.nodeSessions.activeCount(),
            enabledCredentials: options.credentialReloader.getStatus().enabled,
        } : {
            activeNodeSessions: options.nodeSessions.activeCount(),
            enabledCredentials: options.credentialReloader.getStatus().enabled,
            activeRooms: diagnostics.activeRooms,
            activeBattleFacts: diagnostics.activeBattleFacts,
            finalizedBattleFacts: diagnostics.finalizedBattleFacts,
            latestCompatibilityRejection: diagnostics.latestCompatibilityRejection,
        }
        return send(reply, response(200, {
            ok: true,
            value,
        }))
    })
}
