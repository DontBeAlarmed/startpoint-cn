// Ranking Event local summary. Frozen ranking rewards remain unsupported.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerQuestLocalRankPercentageSync, getPlayerSingleQuestProgressSync } from "../../data/domains/quest"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { QuestCategory } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";

interface GetSummaryBody {
    viewer_id: number,
    ranking_event_id: number,
    quest_kind: number
}

const rankingEventIdQuestMap: Record<number, number> = {
    [1]: 1001,
    [2]: 2001,
    [3]: 3001,
    [4]: 4001,
    [5]: 5001,
    [1000]: 1000001,
    [1001]: 1001001
}

/**
 * Generates a ranking summary for a specific player & ranking event.
 * 
 * @param playerId 
 * @param eventId 
 * @returns 
 */
function getRankingSummary(
    playerId: number,
    eventId: number
): Object | null {
    // get quest
    const questId = rankingEventIdQuestMap[eventId]
    if (questId === undefined) return null;

    const playerQuestData = getPlayerSingleQuestProgressSync(playerId, QuestCategory.RANKING_EVENT_SINGLE, questId)
    if (playerQuestData === null
        || (playerQuestData.bestElapsedTimeMs === undefined
            && playerQuestData.highScore === undefined)) return { best_record: null }

    const leaderCharacterId = playerQuestData.leaderCharacterId
    if (!Number.isSafeInteger(leaderCharacterId) || leaderCharacterId! <= 0) return { best_record: null }
    const leaderCharacter = getPlayerCharacterSync(playerId, leaderCharacterId!)
    const rankPercentage = getPlayerQuestLocalRankPercentageSync(
        playerId,
        QuestCategory.RANKING_EVENT_SINGLE,
        questId,
    )
    if (leaderCharacter === null || rankPercentage === null) return { best_record: null }

    const isAccomplished = playerQuestData.bestElapsedTimeMs !== undefined
        && playerQuestData.bestElapsedTimeMs !== null

    return {
        "best_record": {
            "elapsed_time_ms": isAccomplished ? playerQuestData.bestElapsedTimeMs ?? 0 : 0,
            "is_accomplished": isAccomplished,
            "score": playerQuestData.highScore ?? 0
        },
        "leader_character_evolution_img_level": leaderCharacter.evolutionLevel,
        "leader_character_id": leaderCharacterId,
        "rank_border_top": null,
        "rank_percentage": rankPercentage
    }
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

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!

        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get summary
        const summary = getRankingSummary(playerId, eventId)
        if (summary === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Summary could not be generated for '${eventId}' and PlayerId '${playerId}'.`
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": summary
        })
    })

}

export default routes;
