import { randomUUID } from "node:crypto"

import {
    MULTI_PROTOCOL_VERSION,
    type CoordinatorErrorCode,
    type CoordinatorResult,
    type NodeSessionId,
} from "../coordinator/contracts"
import type { MultiHubTcpEndpoint } from "./control-routes"
import {
    isHubNodeSessionPayload,
    isHubSuccessValue,
    type HubNodeSessionPayload,
} from "./response-validator"

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
const RETRY_ATTEMPTS = 2

const COORDINATOR_ERRORS = new Set<CoordinatorErrorCode>([
    "INCOMPATIBLE_ROOM",
    "VIEWER_ID_CONFLICT",
    "QUEST_NOT_AVAILABLE",
    "ROOM_PERMISSION_DENIED",
    "ROOM_NOT_FOUND",
    "HUB_UNAVAILABLE",
])

type HubNodeSession = HubNodeSessionPayload

interface HubResponse {
    readonly status: number
    readonly body: unknown
}

export interface HubClientOptions {
    readonly hubUrl: URL
    readonly token: string
    readonly fetch?: typeof fetch
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
    readonly now?: () => number
    readonly createIdempotencyKey?: () => string
}

export class HubClient {
    private readonly hubUrl: URL
    private readonly token: string
    private readonly fetchImpl: typeof fetch
    private readonly timeoutMs: number
    private readonly maxResponseBytes: number
    private readonly now: () => number
    private readonly createIdempotencyKey: () => string
    private session: HubNodeSession | null = null
    private registration: Promise<HubNodeSession> | null = null
    private available = false

    constructor(options: HubClientOptions) {
        this.hubUrl = new URL(options.hubUrl.href)
        this.token = options.token
        this.fetchImpl = options.fetch ?? fetch
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
        this.now = options.now ?? Date.now
        this.createIdempotencyKey = options.createIdempotencyKey ?? randomUUID
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0
            || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
            throw new TypeError("Hub client limits must be positive safe integers")
        }
    }

    read<T>(route: string, input: unknown): Promise<CoordinatorResult<T>> {
        return this.call<T>(route, input, null)
    }

    write<T>(
        route: string,
        input: unknown,
        idempotencyKey = this.createIdempotencyKey(),
    ): Promise<CoordinatorResult<T>> {
        return this.call<T>(route, input, idempotencyKey)
    }

    getTcpEndpoint(): MultiHubTcpEndpoint | null {
        return this.getLiveSession()?.tcp ?? null
    }

    getNodeSessionId(): NodeSessionId | null {
        return this.getLiveSession()?.nodeSessionId ?? null
    }

    isAvailable(): boolean {
        return this.getLiveSession() !== null && this.available
    }

    private async call<T>(
        route: string,
        input: unknown,
        idempotencyKey: string | null,
    ): Promise<CoordinatorResult<T>> {
        let refreshed = false
        while (true) {
            let session: HubNodeSession
            try {
                session = await this.ensureSession()
            } catch {
                this.available = false
                return { ok: false, error: "HUB_UNAVAILABLE" }
            }

            const response = await this.requestWithRetry(
                route,
                this.bindParticipant(input, session.nodeSessionId),
                session,
                idempotencyKey,
                idempotencyKey !== null && refreshed ? 1 : RETRY_ATTEMPTS,
            )
            if (response?.status === 401) {
                if (this.session === session) this.session = null
                if (refreshed) {
                    this.available = false
                    return { ok: false, error: "HUB_UNAVAILABLE" }
                }
                refreshed = true
                continue
            }
            if (response === null) {
                this.available = false
                return { ok: false, error: "HUB_UNAVAILABLE" }
            }
            const normalized = this.normalizeResult<T>(route, response)
            this.available = normalized.trusted
            return normalized.result
        }
    }

    private async ensureSession(): Promise<HubNodeSession> {
        const current = this.getLiveSession()
        if (current !== null) return current
        if (this.registration !== null) return this.registration
        let tracked!: Promise<HubNodeSession>
        tracked = this.register().finally(() => {
            if (this.registration === tracked) this.registration = null
        })
        this.registration = tracked
        return tracked
    }

    private async register(): Promise<HubNodeSession> {
        const response = await this.requestJson("/v1/multi/nodes/register", {
            method: "POST",
            headers: {
                authorization: `Bearer ${this.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ protocolVersion: MULTI_PROTOCOL_VERSION }),
        })
        if (response.status !== 200
            || !isHubNodeSessionPayload(response.body)
            || response.body.expiresAt <= this.now()) {
            throw new Error("Hub registration failed")
        }
        this.session = Object.freeze({
            nodeSessionId: response.body.nodeSessionId as NodeSessionId,
            sessionCredential: response.body.sessionCredential,
            expiresAt: response.body.expiresAt,
            tcp: Object.freeze({ ...response.body.tcp }),
        })
        this.available = true
        return this.session
    }

    private async requestWithRetry(
        route: string,
        input: unknown,
        session: HubNodeSession,
        idempotencyKey: string | null,
        maxAttempts: number,
    ): Promise<HubResponse | null> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const headers: Record<string, string> = {
                    authorization: `Bearer ${session.sessionCredential}`,
                    "content-type": "application/json",
                    "x-node-session-id": session.nodeSessionId,
                }
                if (idempotencyKey !== null) headers["x-idempotency-key"] = idempotencyKey
                const response = await this.requestJson(route, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(input),
                })
                if (response.status < 500 || attempt === maxAttempts - 1) {
                    return response
                }
            } catch {
                if (attempt === maxAttempts - 1) return null
            }
        }
        return null
    }

    private async requestJson(route: string, init: RequestInit): Promise<HubResponse> {
        const controller = new AbortController()
        const timeout = setTimeout(() => {
            controller.abort(new Error("Hub request timed out"))
        }, this.timeoutMs)
        try {
            const response = await this.fetchImpl(new URL(route, this.hubUrl), {
                ...init,
                signal: controller.signal,
            })
            const contentLength = Number(response.headers.get("content-length"))
            if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
                await response.body?.cancel()
                throw new Error("Hub response is too large")
            }
            if (response.body === null) return { status: response.status, body: null }

            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let total = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                total += value.byteLength
                if (total > this.maxResponseBytes) {
                    await reader.cancel()
                    throw new Error("Hub response is too large")
                }
                chunks.push(value)
            }
            const bytes = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.byteLength
            }
            return {
                status: response.status,
                body: JSON.parse(new TextDecoder().decode(bytes)),
            }
        } finally {
            clearTimeout(timeout)
        }
    }

    private bindParticipant(input: unknown, nodeSessionId: NodeSessionId): unknown {
        if (input === null || typeof input !== "object" || Array.isArray(input)) return input
        const record = input as Record<string, unknown>
        const participant = record.participant
        if (participant === null || typeof participant !== "object" || Array.isArray(participant)) {
            return input
        }
        return {
            ...record,
            participant: {
                ...(participant as Record<string, unknown>),
                nodeSessionId,
            },
        }
    }

    private normalizeResult<T>(route: string, response: HubResponse): {
        readonly result: CoordinatorResult<T>
        readonly trusted: boolean
    } {
        if (response.status !== 200
            || response.body === null
            || typeof response.body !== "object") {
            return { result: { ok: false, error: "HUB_UNAVAILABLE" }, trusted: false }
        }
        const body = response.body as { ok?: unknown; value?: unknown; code?: unknown }
        if (body.ok === true && isHubSuccessValue<T>(route, body.value)) {
            return { result: { ok: true, value: body.value }, trusted: true }
        }
        if (body.ok === false && COORDINATOR_ERRORS.has(body.code as CoordinatorErrorCode)) {
            return {
                result: { ok: false, error: body.code as CoordinatorErrorCode },
                trusted: true,
            }
        }
        return { result: { ok: false, error: "HUB_UNAVAILABLE" }, trusted: false }
    }

    private getLiveSession(): HubNodeSession | null {
        if (this.session !== null && this.session.expiresAt <= this.now()) {
            this.session = null
            this.available = false
        }
        return this.session
    }
}
