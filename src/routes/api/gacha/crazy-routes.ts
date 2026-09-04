import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../../data/activeAccount"
import { getSession } from "../../../data/domains/session"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../../lib/character-growth/owner-publication"
import {
    projectCrazyGachaSaveResponse,
    projectCrazyGachaSelectResponse,
    acknowledgeGachaConversionShownSync,
    runGachaPostCommitEffects,
    saveCrazyGachaCandidateSync,
    selectCrazyGachaCandidateSync,
} from "../../../lib/gacha-owner"
import { getVirtualNow } from "../../../runtime/time/game-time"
import { generateDataHeaders } from "../../../utils"

interface SaveBody {
    readonly viewer_id: number
    readonly index: number
}

interface SelectBody extends SaveBody {
    readonly gacha_id: number
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

async function resolvePlayer(body: SaveBody): Promise<number | null> {
    if (!positiveInteger(body.viewer_id)) return null
    const session = await getSession(String(body.viewer_id))
    return session === null ? null : resolvePlayerIdSync(session.accountId)
}

function protocolError(
    reply: FastifyReply,
    viewerId: number,
    resultCode: 1351 | 1361,
) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data: {},
    })
}

export function registerCrazyGachaRoutes(fastify: FastifyInstance): void {
    fastify.post("/shown_converted", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectBody
        if (!positiveInteger(body.viewer_id) || !positiveInteger(body.gacha_id)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const playerId = await resolvePlayer(body)
        if (playerId === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        acknowledgeGachaConversionShownSync(playerId, body.gacha_id)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
            data: {},
        })
    })

    fastify.post("/crazy_gacha_save", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SaveBody
        if (!positiveInteger(body.viewer_id) || (body.index !== 1 && body.index !== 2)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const playerId = await resolvePlayer(body)
        if (playerId === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const result = saveCrazyGachaCandidateSync({
            playerId,
            targetSlot: body.index,
            nowMs: getVirtualNow().getTime(),
        })
        if (!result.ok) {
            if (result.kind === "protocolResultCode") {
                return protocolError(reply, body.viewer_id, result.resultCode)
            }
            return reply.status(400).send({ error: "Bad Request", message: result.message })
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectCrazyGachaSaveResponse({
            dataHeaders: generateDataHeaders({ viewer_id: body.viewer_id }),
            result,
        }))
    })

    fastify.post("/crazy_gacha_select", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectBody
        if (!positiveInteger(body.viewer_id)
            || !positiveInteger(body.gacha_id)
            || (body.index !== 0 && body.index !== 1 && body.index !== 2)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const playerId = await resolvePlayer(body)
        if (playerId === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const result = selectCrazyGachaCandidateSync({
            playerId,
            gachaId: body.gacha_id,
            slot: body.index,
            nowMs: getVirtualNow().getTime(),
        })
        if (!result.ok) {
            if (result.kind === "protocolResultCode") {
                return protocolError(reply, body.viewer_id, result.resultCode)
            }
            return reply.status(400).send({ error: "Bad Request", message: result.message })
        }
        const postCommit = runGachaPostCommitEffects(result, {
            publishGrowth: (id, characterIds, characters, source) => (
                publishCharacterGrowthOwnerStateBestEffort(
                    id,
                    [...characterIds],
                    [[...characters]],
                    {},
                    source,
                ).characterList
            ),
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectCrazyGachaSelectResponse({
            dataHeaders: generateDataHeaders({ viewer_id: body.viewer_id }),
            result,
            postCommit,
        }))
    })
}
