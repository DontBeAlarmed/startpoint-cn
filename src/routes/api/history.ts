import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getReceiveHistorySync } from "../../data/domains/mail"
import { getPlayerScoreAttackBattleHistorySync } from "../../data/domains/score-attack-history"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestContentTableSync } from "../../lib/assets";
import { generateDataHeaders } from "../../utils";

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request",
            message: "No player bound to account."
        })

        const records = getReceiveHistorySync(playerId, 7, 500)
        const history = records.map(r => ({
            create_time: r.create_time,
            description: null,
            number: r.number,
            reason_id: r.reason_id,
            subject: null,
            type: r.type,
            type_id: r.type_id,
        }))

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { history, total_count: records.length }
        })
    })

    fastify.post("/practice_battle", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request", message: "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { history: [] }
        })
    })

    fastify.post("/score_attack_event_battle", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        const eventId = body.event_id
        if (!viewerId || isNaN(viewerId)
            || !Number.isSafeInteger(eventId) || eventId <= 0) return reply.status(400).send({
            error: "Bad Request", message: "Invalid request body."
        })
        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request", message: "Invalid viewer id."
        })
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) return reply.status(400).send({
            error: "Bad Request", message: "No player bound to account."
        })
        const eventExists = Object.values(getQuestContentTableSync("score_attack_event_quest.json"))
            .some(quest => quest.eventId === eventId)
        if (!eventExists) return reply.status(400).send({
            error: "Bad Request", message: "Score attack event doesn't exist."
        })
        const history = getPlayerScoreAttackBattleHistorySync(playerId, eventId)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { history }
        })
    })
}

export default routes
