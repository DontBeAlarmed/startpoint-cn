import type { FastifyReply } from "fastify"
import { ManaNodeMutationValidationError } from "../../../lib/character-mana-mutation-types"

const SERVER_STATE_ERRORS = new Set([
    "CONTENT_INVALID",
    "CONTENT_SCOPE_MISMATCH",
    "SNAPSHOT_INVALID",
    "AWAKE_COST_MISSING",
    "COST_OVERFLOW",
])

export function sendManaMutationError(
    reply: FastifyReply,
    error: unknown,
): boolean {
    if (!(error instanceof ManaNodeMutationValidationError)) return false
    const statusCode = SERVER_STATE_ERRORS.has(error.code) ? 500 : 400
    reply.status(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Bad Request",
        message: error.message,
    })
    return true
}
