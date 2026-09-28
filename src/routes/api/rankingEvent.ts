// Ranking event summary + reward claims. Tier selection and reward
// distribution share the official ranking_event_ranking_reward table and the
// same placement source, so what the client displays is what gets granted.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import {
    claimRankingReward,
    getRankingEventQuestId,
    getRankingSummaryPayload,
} from "../../lib/ranking-reward";

interface GetSummaryBody {
    viewer_id: number,
    ranking_event_id: number,
    quest_kind: number
}

interface ReceiveRewardBody {
    viewer_id: number,
    ranking_event_id: number
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_summary", async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.body === null
            || typeof request.body !== "object"
            || Array.isArray(request.body)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const body = request.body as GetSummaryBody

        const viewerId = body.viewer_id
        const eventId = body.ranking_event_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(eventId) || eventId <= 0
            || body.quest_kind !== 1) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        if (getRankingEventQuestId(eventId) === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Summary could not be generated for '${eventId}' and PlayerId '${playerId}'.`
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": getRankingSummaryPayload(playerId, eventId)
        })
    })

    // Official claim decision table:
    //   no participation record / unknown event -> status 3 (nothing to claim)
    //   first claim  -> grant tier rewards + claim record in one transaction -> status 1
    //   repeat claim -> summary only, no further grants                     -> status 2
    fastify.post("/receive_reward", async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.body === null
            || typeof request.body !== "object"
            || Array.isArray(request.body)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const body = request.body as ReceiveRewardBody

        const viewerId = body.viewer_id
        const eventId = body.ranking_event_id
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(eventId) || eventId <= 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const outcome = claimRankingReward(playerId, eventId)
        if (outcome === null) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "status": 3
                }
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "status": outcome.status,
                ...outcome.summary
            }
        })
    })

}

export default routes;
