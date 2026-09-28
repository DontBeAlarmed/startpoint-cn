import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../../data/db";
import { getPlayerCharacterSync } from "../../data/domains/character";
import { getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestFromCategorySync } from "../../lib/quest-content";
import { givePlayerCharacterSync } from "../../lib/character";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { grantStoryRewardWithinTransactionSync } from "../../lib/story-reward-grant"
import { reconcileActiveMissionFacts } from "../../lib/mission";
import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "../../lib/mission/response-fragment";
import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../../lib/common-response/entities";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge";
import type { CommonResponseFragment } from "../../lib/common-response/model";
import { settleCharacterStoryFactMissions } from "../../lib/mission/story-fact-settlement";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getQuestJoinCharacterIds } from "../../lib/story-join-character";
import { generateDataHeaders, getServerTime } from "../../utils";
import { QuestCategory } from "../../lib/types";
import { recordCompletedMainChapterMilestoneSync } from "../../lib/player-history-milestones";
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow/common-response";

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

function isStoryFinishCategory(category: number): boolean {
    return category === QuestCategory.MAIN || category === QuestCategory.CHARACTER
}

function processStoryQuestFinish(
    playerId: number,
    viewerId: number,
    questSection: number,
    questId: number,
) {
    if (!isStoryFinishCategory(questSection)) {
        console.log(`[STORY] category is not supported by story finish: category=${questSection}`)
        return null
    }
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
        const rewardGrant = firstClear && questData.clearReward !== undefined
            ? grantStoryRewardWithinTransactionSync(playerId, questData.clearReward)
            : null
        const rewardResult = rewardGrant?.rewardResult ?? null
        const storyJoinCharacterIds: number[] = []
        const storyCandidateCharacterIds = getQuestJoinCharacterIds(questSection, questId)
        const storyCharacterList: Record<string, unknown>[] = []

        if (firstClear) {
            for (const characterId of storyCandidateCharacterIds) {
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
            if (questSection === QuestCategory.MAIN) {
                recordCompletedMainChapterMilestoneSync(playerId, questId)
            }
        }

        const evaluationTime = new Date(getServerTime() * 1000)
        const missionSettlement = firstClear && questSection === QuestCategory.CHARACTER
            ? settleCharacterStoryFactMissions(playerId, evaluationTime)
            : null
        const playerAfter = getPlayerSync(playerId)
        if (playerAfter === null) throw new Error(`Player ${playerId} disappeared during story settlement.`)
        const existingCharacterList = [
            ...((rewardResult?.character_list ?? []) as Record<string, unknown>[]),
            ...storyCharacterList,
        ]
        const activeMissionList = reconcileActiveMissionFacts({
            playerId,
            now: evaluationTime.getTime(),
        })
        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            storyCandidateCharacterIds,
            [existingCharacterList],
            {
                invalidatedFactKeys: [
                    ...(rewardGrant?.invalidatedFactKeys ?? []),
                    ...(firstClear && questSection === QuestCategory.CHARACTER
                        ? [{ kind: "questProgress" as const, sections: [QuestCategory.CHARACTER] }]
                        : []),
                ],
            },
            "story/finish",
            evaluationTime,
        ).characterList
        const overMax = projectItemOverflowCommonResponse(
            rewardResult?.itemOverflowDispositions ?? [],
        )
        const fragment: CommonResponseFragment = {
            user_info: {
                free_vmoney: playerAfter.freeVmoney,
                free_mana: playerAfter.freeMana,
                exp_pool: playerAfter.expPool,
            },
            character_list: characterList.map(
                character => projectCharacterPatch(character),
            ),
            equipment_list: (rewardResult?.equipment_list ?? []).map(
                equipment => projectEquipmentEntity(equipment),
            ),
            item_list: rewardResult?.items ?? {},
            mail_arrived: getMailArrivedSync(playerId),
            ...(overMax.length > 0 ? { over_max: overMax } : {}),
        }
        const responseData: Record<string, unknown> = {
            ...mergeCommonResponseFragments([fragment]),
            joined_character_id_list: rewardResult?.joined_character_id_list ?? [],
            story_join_character_id_list: storyJoinCharacterIds,
            user_notice_list: [],
            presigned_quest_category: [],
            active_mission_list: activeMissionList,
        }
        if (missionSettlement) {
            composeMissionSettlementResponse(
                responseData,
                projectMissionSettlementFragment(missionSettlement),
                viewerId,
            )
        }
        return responseData
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

        const result = processStoryQuestFinish(playerId, viewerId, body.category, body.quest_id)
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

        const result = processStoryQuestFinish(playerId, viewerId, body.category, body.quest_id)
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
