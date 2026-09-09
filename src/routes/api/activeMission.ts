// Active mission reward claiming endpoint
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, updatePlayerActiveMissionStageSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { generateDataHeaders, getServerTime } from "../../utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import {
    validateMissionRewardClaims,
} from "../../lib/mission/index";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { MissionRewardGranter } from "../../lib/mission/grants";
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time";
import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../../lib/common-response/entities";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge";
import type { CommonResponseFragment } from "../../lib/common-response/model";
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow/common-response";

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number,
            api_count: number,
            active_mission_list: { mission_id: number, stages: number[] }[]
        }

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const requestList = body.active_mission_list || []
        const evaluationTime = getServerTime() * 1000
        const settlement = getDb().transaction(() => {
            const player = getPlayerSync(playerId)
            if (!player) return { ok: false as const, status: 500 as const, message: "Player not found." }
            const validation = validateMissionRewardClaims(
                getPlayerActiveMissionsSync(playerId),
                requestList,
                {
                    now: evaluationTime,
                    questProgress: getPlayerQuestProgressSync(playerId),
                },
            )
            if (!validation.ok) {
                return { ok: false as const, status: 400 as const, message: validation.message }
            }
            const granter = new MissionRewardGranter(playerId, player)
            const resultByMission = new Map<number, {
                mission_id: number,
                progress_value: number,
                stages: { stage: number, received: boolean }[]
            }>()
            for (const claim of validation.claims) {
                updatePlayerActiveMissionStageSync(playerId, claim.stage, claim.missionId, true)
                let result = resultByMission.get(claim.missionId)
                if (!result) {
                    result = { mission_id: claim.missionId, progress_value: claim.progress, stages: [] }
                    resultByMission.set(claim.missionId, result)
                }
                result.stages.push({ stage: claim.stage, received: true })
                granter.grant(claim.rewards)
            }
            granter.persistPlayer()
            const existingCharacterList = granter.characterList as unknown as Record<string, unknown>[]
            const characterList = validation.claims.length > 0
                ? (() => {
                    return publishCharacterGrowthOwnerStateBestEffort(
                        playerId,
                        [],
                        [existingCharacterList],
                        { invalidatedFactKeys: granter.invalidatedFactKeys },
                        "active-mission/receive",
                        new Date(evaluationTime),
                    ).characterList
                })()
                : existingCharacterList
            return {
                ok: true as const,
                player,
                resultList: [...resultByMission.values()],
                characterList,
                userInfo: granter.getUserInfo(),
                equipmentList: granter.equipmentList,
                itemList: granter.itemList,
                degreeList: granter.degreeList,
                itemOverflowDispositions: granter.itemOverflowDispositions,
            }
        })()
        if (!settlement.ok) return reply.status(settlement.status).send({
            "error": settlement.status === 400 ? "Bad Request" : "Internal Server Error",
            "message": settlement.message,
        })

        console.log(`[ACTIVE_MISSION] receive viewer=${viewerId} missions=${requestList.length} items=${Object.keys(settlement.itemList).length}`)
        const overMax = projectItemOverflowCommonResponse(settlement.itemOverflowDispositions)
        const fragment: CommonResponseFragment = {
            "user_info": {
                ...settlement.userInfo,
                "exp_pooled_time": expPoolRealDateToClientTimestamp(settlement.player.expPooledTime)
            },
            "character_list": settlement.characterList.map(
                character => projectCharacterPatch(character),
            ),
            "equipment_list": settlement.equipmentList.map(
                equipment => projectEquipmentEntity(equipment),
            ),
            "item_list": settlement.itemList,
            "mail_arrived": getPlayerMailCountSync(playerId, true) > 0,
            ...(overMax.length > 0 ? { "over_max": overMax } : {}),
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "active_mission_list": settlement.resultList,
                ...mergeCommonResponseFragments([fragment]),
                "degree_list": settlement.degreeList.map(degreeId => ({ viewer_id: viewerId, degree_id: degreeId })),
            }
        })
    })
}

export default routes;
