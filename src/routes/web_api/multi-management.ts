import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    MultiHubCredentialStoreError,
    type IssuedMultiHubCredential,
    type MultiHubCredential,
} from "../../multi/hub/credential-store"
import { MultiHubCredentialLockError } from "../../multi/hub/credential-lock"
import { requireLoopback } from "../../multi/management/loopback"
import {
    MultiManagementError,
} from "../../multi/management/service"
import type {
    MultiManagementServiceContract,
    MultiProbeResult,
} from "../../multi/management/types"

interface CreateCredentialBody {
    readonly label?: unknown
}

interface CredentialParams {
    readonly credentialId: string
}

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
