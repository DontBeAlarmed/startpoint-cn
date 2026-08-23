import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../../data/db";
import { getPlayerCharacterSync } from "../../data/domains/character";
import { getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestFromCategorySync } from "../../lib/assets";
import { givePlayerCharacterSync } from "../../lib/character";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { givePlayerRewardSync } from "../../lib/quest";
import {
    reconcileActiveMissionFacts,
    reconcileAwakeUnlockCharacterListBestEffort,
} from "../../lib/mission";
import { collectAwakeCandidateCharacterIds } from "../../lib/mission/awake-candidate-character-ids";
import { createAwakeRequestContextBestEffort } from "../../lib/mission/awake-best-effort-context";
import { getQuestJoinCharacterIds } from "../../lib/story-join-character";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getContentSnapshot } from "../../content/runtime/content-snapshot";

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

function processStoryQuestFinish(playerId: number, questSection: number, questId: number) {
    const questData = getQuestFromCategorySync(questSection, questId)
    if (questData === null) {
        console.log(`[STORY] quest not found: category=${questSection} questId=${questId}`)
        return null
    }
    if (questData.sPlusReward !== undefined) {
        console.log(`[STORY] battle quest rejected: category=${questSection} questId=${questId}`)
        return null
    }

    return getDb().transaction(() => {
        const playerBefore = getPlayerSync(playerId)
        if (playerBefore === null) return null

        const questProgress = getPlayerSingleQuestProgressSync(playerId, questSection, questId)
        const firstClear = questProgress?.finished !== true
        const rewardResult = firstClear && questData.clearReward !== undefined
            ? givePlayerRewardSync(playerId, questData.clearReward)
            : null
        const storyJoinCharacterIds: number[] = []
        const storyCharacterList: Record<string, unknown>[] = []

        if (firstClear) {
            for (const characterId of getQuestJoinCharacterIds(questSection, questId)) {
                if (getPlayerCharacterSync(playerId, characterId) !== null) continue
                const giveResult = givePlayerCharacterSync(playerId, characterId)
                if (!giveResult?.character) {
                    throw new Error(`Story join character ${characterId} is missing from character content.`)
                }
                storyJoinCharacterIds.push(characterId)
                storyCharacterList.push(giveResult.character as Record<string, unknown>)
            }

            if (questProgress === null) {
                insertPlayerQuestProgressSync(playerId, questSection, {
                    questId,
                    finished: true,
                    clearRank: 5,
                })
            } else {
                updatePlayerQuestProgressSync(playerId, questSection, {
                    questId,
                    finished: true,
                    clearRank: 5,
                })
            }
        }

        const playerAfter = getPlayerSync(playerId)
        if (playerAfter === null) throw new Error(`Player ${playerId} disappeared during story settlement.`)
        const existingCharacterList = [
            ...((rewardResult?.character_list ?? []) as Record<string, unknown>[]),
            ...storyCharacterList,
        ]
        const activeMissionList = reconcileActiveMissionFacts({
            playerId,
            repository: getContentSnapshot().repository,
            now: getServerTime() * 1000,
        })
        const candidateCharacterIds = collectAwakeCandidateCharacterIds(
            storyJoinCharacterIds,
            [existingCharacterList],
        )
        const awakeContext = createAwakeRequestContextBestEffort(playerId, candidateCharacterIds)
        const characterList = awakeContext === null
            ? existingCharacterList
            : reconcileAwakeUnlockCharacterListBestEffort(
                playerId,
                existingCharacterList,
                { context: awakeContext, candidateCharacterIds },
            )
        return {
            user_info: {
                free_vmoney: playerAfter.freeVmoney,
                free_mana: playerAfter.freeMana,
                exp_pool: playerAfter.expPool,
            },
            character_list: characterList,
            joined_character_id_list: rewardResult?.joined_character_id_list ?? [],
            equipment_list: rewardResult?.equipment_list ?? [],
            item_list: rewardResult?.items ?? {},
            story_join_character_id_list: storyJoinCharacterIds,
            user_notice_list: [],
            presigned_quest_category: [],
            active_mission_list: activeMissionList,
            mail_arrived: getMailArrivedSync(playerId),
        }
    })()
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

        const result = processStoryQuestFinish(playerId, body.category, body.quest_id)
        if (result === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid quest ID provided."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result
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

        const result = processStoryQuestFinish(playerId, body.category, body.quest_id)
        if (result === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid quest ID provided."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result
        })
    })
}

export default routes;
