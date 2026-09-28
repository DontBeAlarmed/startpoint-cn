import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../../data/activeAccount"
import { getSession } from "../../../data/domains/session"
import {
    executeGachaExchangeSync,
    projectGachaExchangeResponse,
    runGachaPostCommitEffects,
} from "../../../lib/gacha-owner"
import { getVirtualNow } from "../../../runtime/time/game-time"
import { generateDataHeaders } from "../../../utils"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../../lib/character-growth/owner-publication"

interface ExchangeBody {
    readonly viewer_id: number
    readonly gacha_id: number
    readonly character_id?: number
    readonly equipment_id?: number
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

async function handleExchange(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: "character" | "equipment",
) {
    const body = request.body as ExchangeBody
    const viewerId = body.viewer_id
    const gachaId = body.gacha_id
    const targetId = kind === "character" ? body.character_id : body.equipment_id
    if (!positiveInteger(viewerId) || !positiveInteger(gachaId) || !positiveInteger(targetId)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
    }
    const session = await getSession(String(viewerId))
    if (session === null) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
    }
    const playerId = resolvePlayerIdSync(session.accountId)
    if (playerId === null) {
        return reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        })
    }
    const result = executeGachaExchangeSync({
        playerId,
        gachaId,
        targetId,
        kind,
        nowMs: getVirtualNow().getTime(),
    })
    if (!result.ok) {
        if (result.kind === "protocolResultCode") {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({
                    viewer_id: viewerId,
                    result_code: result.resultCode,
                }),
                data: {},
            })
        }
        return reply.status(400).send({ error: "Bad Request", message: result.message })
    }
    const postCommit = runGachaPostCommitEffects(result, {
        publishGrowth: (playerId, characterIds, characters, source) => (
            publishCharacterGrowthOwnerStateBestEffort(
                playerId,
                [...characterIds],
                [[...characters]],
                {},
                source,
            ).characterList
        ),
    })
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send(projectGachaExchangeResponse({
        dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
        result,
        postCommit,
    }))
}

export function registerGachaExchangeRoutes(fastify: FastifyInstance): void {
    fastify.post("/exchange_character", (request, reply) => (
        handleExchange(request, reply, "character")
    ))
    fastify.post("/exchange_equipment", (request, reply) => (
        handleExchange(request, reply, "equipment")
    ))
}
