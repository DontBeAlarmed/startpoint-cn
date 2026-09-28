import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getSession } from "../../data/domains/session"
import {
    executeGachaDrawSync,
    executeCrazyGachaCandidateSync,
    projectCrazyGachaCandidateResponse,
    projectGachaExecResponse,
    runGachaPostCommitEffects,
} from "../../lib/gacha-owner"
import { getVirtualNow } from "../../runtime/time/game-time"
import { generateDataHeaders } from "../../utils"
import { registerGachaExchangeRoutes } from "./gacha/exchange-routes"
import { registerCrazyGachaRoutes } from "./gacha/crazy-routes"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication"
import { GACHA_EXEC_TYPES } from "../../lib/gacha-rules"

interface ExecBody {
    readonly viewer_id: number
    readonly gacha_id: number
    readonly payment_type: number
    readonly number_of_exec: number
    readonly type: number
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

async function handleExec(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as ExecBody
    const viewerId = body.viewer_id
    const gachaId = body.gacha_id
    const paymentType = body.payment_type
    const numberOfExec = body.number_of_exec
    const execType = body.type
    if (!positiveInteger(viewerId)
        || !positiveInteger(gachaId)
        || !positiveInteger(paymentType)
        || !positiveInteger(numberOfExec)
        || !positiveInteger(execType)) {
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

    const command = {
        playerId,
        gachaId,
        paymentType,
        execType,
        numberOfExec,
        nowMs: getVirtualNow().getTime(),
    }
    if (execType === GACHA_EXEC_TYPES.CRAZY_MULTI_TICKET) {
        const result = executeCrazyGachaCandidateSync(command)
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
        runGachaPostCommitEffects(result, {
            publishGrowth: () => [],
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectCrazyGachaCandidateResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
        }))
    }

    const result = executeGachaDrawSync(command)
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
    return reply.status(200).send(projectGachaExecResponse({
        dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
        result,
        postCommit,
    }))
}

export default async function gachaRoutes(fastify: FastifyInstance): Promise<void> {
    registerGachaExchangeRoutes(fastify)
    registerCrazyGachaRoutes(fastify)
    fastify.post("/exec", handleExec)
}
