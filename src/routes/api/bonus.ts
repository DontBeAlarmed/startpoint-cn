import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getSession } from "../../data/domains/session"
import { confirmLoginBonusesShownSync } from "../../lib/login-bonus"
import { getVirtualNowMs } from "../../runtime/time/game-time"
import { generateDataHeaders } from "../../utils"

interface BonusShownBody {
    readonly viewer_id?: unknown
}

function badRequest(reply: FastifyReply) {
    return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer ID." })
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/shown", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = (request.body as BonusShownBody)?.viewer_id
        if (!Number.isSafeInteger(viewerId) || (viewerId as number) <= 0) {
            return badRequest(reply)
        }
        const session = await getSession(String(viewerId))
        const playerId = session === null ? null : resolvePlayerIdSync(session.accountId)
        if (playerId === null) return badRequest(reply)

        confirmLoginBonusesShownSync(playerId, getVirtualNowMs())
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId as number }),
            data: [],
        })
    })
}

export default routes
