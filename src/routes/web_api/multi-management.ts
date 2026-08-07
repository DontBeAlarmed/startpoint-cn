import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    MultiHubCredentialStoreError,
    type IssuedMultiHubCredential,
    type MultiHubCredential,
} from "../../multi/hub/credential-store"
import { MAX_AUTHENTICATION_REJECTIONS } from "../../multi/hub/authentication-rejections"
import { MultiHubCredentialLockError } from "../../multi/hub/credential-lock"
import { requireLoopback } from "../../multi/management/loopback"
import {
    MultiManagementError,
} from "../../multi/management/service"
import type {
    MultiAuthenticationDiagnostics,
    MultiManagementServiceContract,
    MultiProbeResult,
} from "../../multi/management/types"

interface CreateCredentialBody {
    readonly label?: unknown
}

interface CredentialParams {
    readonly credentialId: string
}

const SHORT_CREDENTIAL_ID_PATTERN = /^[0-9a-f]{8}$/

export interface MultiManagementRoutesOptions {
    readonly getMultiManagementService: () => MultiManagementServiceContract | null | undefined
}

function publicCredential(credential: MultiHubCredential): MultiHubCredential {
    return {
        credentialId: credential.credentialId,
        label: credential.label,
        createdAt: credential.createdAt,
        revokedAt: credential.revokedAt,
    }
}

function publicIssuedCredential(credential: IssuedMultiHubCredential): IssuedMultiHubCredential {
    return { ...publicCredential(credential), token: credential.token }
}

function publicProbe(result: MultiProbeResult): MultiProbeResult {
    return { state: result.state, checkedAt: result.checkedAt }
}

function publicAuthenticationDiagnostics(
    result: unknown,
): MultiAuthenticationDiagnostics {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError("Invalid authentication diagnostics root")
    }

    const root = result as {
        readonly mode?: unknown
        readonly clientState?: unknown
        readonly rejections?: unknown
    }
    const mode = root.mode
    const clientState = root.clientState
    if (mode !== "embedded" && mode !== "host" && mode !== "client") {
        throw new TypeError("Invalid authentication diagnostics mode")
    }
    if (clientState !== null && clientState !== "authentication_rejected") {
        throw new TypeError("Invalid authentication diagnostics client state")
    }
    if ((mode === "embedded" || mode === "host") && clientState !== null) {
        throw new TypeError("Invalid authentication diagnostics mode state")
    }

    return {
        mode,
        clientState,
        rejections: mode === "host" ? publicAuthenticationRejections(root.rejections) : [],
    }
}

function publicAuthenticationRejections(values: unknown): MultiAuthenticationDiagnostics["rejections"] {
    let candidates: readonly unknown[]
    let length: number
    try {
        if (!Array.isArray(values)) return []
        candidates = values
        length = candidates.length
    } catch {
        return []
    }
    if (!Number.isSafeInteger(length) || length < 0) return []

    const rejections: MultiAuthenticationDiagnostics["rejections"][number][] = []
    const start = Math.max(0, length - MAX_AUTHENTICATION_REJECTIONS)
    for (let index = start; index < length; index += 1) {
        try {
            const candidate = candidates[index]
            if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
                continue
            }
            const timestamp = (candidate as { timestamp?: unknown }).timestamp
            const reason = (candidate as { reason?: unknown }).reason
            if (!isCanonicalAuthenticationTimestamp(timestamp)
                || !isAuthenticationRejectionReason(reason)) {
                continue
            }
            let credential = null
            if (reason === "revoked") {
                const credentialValue = (candidate as { credential?: unknown }).credential
                if (credentialValue !== null) {
                    if (typeof credentialValue !== "object" || Array.isArray(credentialValue)) continue
                    const label = (credentialValue as { label?: unknown }).label
                    const shortId = (credentialValue as { shortId?: unknown }).shortId
                    if (typeof label !== "string"
                        || typeof shortId !== "string"
                        || !SHORT_CREDENTIAL_ID_PATTERN.test(shortId)) continue
                    credential = {
                        label,
                        shortId,
                    }
                }
            }
            rejections.push({
                timestamp,
                reason,
                credential,
            })
        } catch {
            // A malformed service result is not allowed across the public boundary.
        }
    }
    return rejections
}

function isCanonicalAuthenticationTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false
    const milliseconds = Date.parse(value)
    if (!Number.isFinite(milliseconds)) return false
    try {
        return new Date(milliseconds).toISOString() === value
    } catch {
        return false
    }
}

function isAuthenticationRejectionReason(
    value: unknown,
): value is MultiAuthenticationDiagnostics["rejections"][number]["reason"] {
    return value === "malformed" || value === "unknown" || value === "revoked"
}

function getService(
    request: FastifyRequest,
    reply: FastifyReply,
    options: MultiManagementRoutesOptions,
): MultiManagementServiceContract | null {
    if (!requireLoopback(request, reply)) return null
    let service: MultiManagementServiceContract | null | undefined
    try {
        service = options.getMultiManagementService()
    } catch {
        service = null
    }
    if (service !== null && service !== undefined) return service
    reply.status(503).send({
        error: "Service Unavailable",
        code: "MULTI_MANAGEMENT_UNAVAILABLE",
        message: "Multiplayer management is not ready",
    })
    return null
}

function sendManagementError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof MultiManagementError) {
        return reply.status(403).send({
            error: "Forbidden",
            code: error.code,
            message: "Credential management is unavailable in client mode",
        })
    }
    if (error instanceof MultiHubCredentialStoreError) {
        if (error.code === "INVALID_MULTI_HUB_CREDENTIAL_LABEL"
            || error.code === "INVALID_MULTI_HUB_CREDENTIAL_ID") {
            return reply.status(400).send({
                error: "Bad Request",
                code: error.code,
                message: "Credential input is invalid",
            })
        }
        if (error.code === "MULTI_HUB_CREDENTIAL_NOT_FOUND") {
            return reply.status(404).send({
                error: "Not Found",
                code: error.code,
                message: "Credential was not found",
            })
        }
    }
    if (error instanceof MultiHubCredentialStoreError
        || error instanceof MultiHubCredentialLockError) {
        return reply.status(500).send({
            error: "Internal Server Error",
            code: "MULTI_HUB_CREDENTIALS_UNAVAILABLE",
            message: "Credential storage is unavailable",
        })
    }
    return reply.status(500).send({
        error: "Internal Server Error",
        code: "MULTI_MANAGEMENT_FAILED",
        message: "Multiplayer management request failed",
    })
}

const routes = async (fastify: FastifyInstance, options: MultiManagementRoutesOptions) => {
    fastify.get("/authentication-rejections", async (request, reply) => {
        const service = getService(request, reply, options)
        if (service === null) return
        try {
            return reply.status(200).send(
                publicAuthenticationDiagnostics(service.getAuthenticationDiagnostics()),
            )
        } catch (error) {
            return sendManagementError(reply, error)
        }
    })

    fastify.get("/credentials", async (request, reply) => {
        const service = getService(request, reply, options)
        if (service === null) return
        try {
            return reply.status(200).send(service.listCredentials().map(publicCredential))
        } catch (error) {
            return sendManagementError(reply, error)
        }
    })

    fastify.post("/credentials", async (request, reply) => {
        const service = getService(request, reply, options)
        if (service === null) return
        try {
            const label = (request.body as CreateCredentialBody | null)?.label
            return reply.status(201).send(publicIssuedCredential(
                service.createCredential(typeof label === "string" ? label : ""),
            ))
        } catch (error) {
            return sendManagementError(reply, error)
        }
    })

    fastify.delete<{ Params: CredentialParams }>(
        "/credentials/:credentialId",
        async (request, reply) => {
            const service = getService(request, reply, options)
            if (service === null) return
            try {
                return reply.status(200).send(publicCredential(
                    service.revokeCredential(request.params.credentialId),
                ))
            } catch (error) {
                return sendManagementError(reply, error)
            }
        },
    )

    fastify.post("/probe", async (request, reply) => {
        const service = getService(request, reply, options)
        if (service === null) return
        try {
            return reply.status(200).send(publicProbe(await service.probeHub()))
        } catch (error) {
            return sendManagementError(reply, error)
        }
    })
}

export default routes
