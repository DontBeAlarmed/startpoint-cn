import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSingleQuestProgressSync, getPlayerSync, getSession, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestFromCategorySync } from "../../lib/assets";
import { givePlayerRewardSync } from "../../lib/quest";
import { generateDataHeaders } from "../../utils";
import { QuestCategory } from "../../lib/types";

interface FinishBody {
    party_id: number,
    quest_id: number,
    viewer_id: number,
    category: number,
    api_count: number
}

interface FinishWithSkipBody {
    category: number,
    quest_id: number,
    party_id: number,
    viewer_id: number,
    api_count: number
}

function processStoryQuestFinish(playerId: number, viewerId: number, questSection: number, questId: number) {
    const playerData = getPlayerSync(playerId)
    if (playerData === null) return null

    const questData = getQuestFromCategorySync(questSection, questId)
    if (questData === null) {
        console.log(`[STORY] quest not found: category=${questSection} questId=${questId}`)
        return null
    }
    if (questData.sPlusReward !== undefined) {
        console.log(`[STORY] battle quest rejected: category=${questSection} questId=${questId}`)
        return null
    }

    const questProgress = getPlayerSingleQuestProgressSync(playerId, questSection, questId);
    const finished = questProgress !== null ? questProgress.finished : false
    const rewardResult = !finished && questData.clearReward !== undefined ? givePlayerRewardSync(playerId, questData.clearReward) : null

    if (!finished) {
        if (questProgress === null) {
            insertPlayerQuestProgressSync(playerId, questSection, {
                questId: questId,
                finished: true,
                clearRank: 0
            })
        } else {
            updatePlayerQuestProgressSync(playerId, questSection, {
                questId: questId,
                finished: true,
                clearRank: 0
            })
        }
    }

    return {
        data: !finished ? {
            "user_info": {
                "free_vmoney": playerData.freeVmoney + (rewardResult?.user_info.free_vmoney || 0),
                "free_mana": playerData.freeMana + (rewardResult?.user_info.free_mana || 0)
            },
            "character_list": rewardResult?.character_list || [],
            "joined_character_id_list": rewardResult?.joined_character_id_list || [],
            "equipment_list": rewardResult?.equipment_list || [],
            "items": rewardResult?.items || {},
            "presigned_quest_category": []
        } : []
    }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
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

        const result = processStoryQuestFinish(playerId, viewerId, body.category, body.quest_id)
        if (result === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid quest ID provided."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result.data
        })
    })

    // finish_with_skip — NPC helper auto-complete (no score/statistics)
    fastify.post("/finish_with_skip", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishWithSkipBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
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

        const result = processStoryQuestFinish(playerId, viewerId, body.category, body.quest_id)
        if (result === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid quest ID provided."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result.data
        })
    })
}

export default routes;
