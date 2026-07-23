// Active mission reward claiming endpoint
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, updatePlayerActiveMissionStageSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { generateDataHeaders, getServerTime } from "../../utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { reconcileAwakeUnlockCharacterList, validateMissionRewardClaims } from "../../lib/mission/index";
import { MissionRewardGranter } from "../../lib/mission/grants";

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

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "Player not found."
        })

        const activeMissions = getPlayerActiveMissionsSync(playerId)
        const requestList = body.active_mission_list || []
        const validation = validateMissionRewardClaims(activeMissions, requestList)
        if (!validation.ok) return reply.status(400).send({
            "error": "Bad Request",
            "message": validation.message
        })

        const granter = new MissionRewardGranter(playerId, player)
        const resultByMission = new Map<number, {
            mission_id: number,
            progress_value: number,
            stages: { stage: number, received: boolean }[]
        }>()

        const characterList = getDb().transaction(() => {
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
            return validation.claims.length > 0
                ? reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
                : existingCharacterList
        })()

        const resultList = [...resultByMission.values()]
        console.log(`[ACTIVE_MISSION] receive viewer=${viewerId} missions=${requestList.length} items=${Object.keys(granter.itemList).length}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "active_mission_list": resultList,
                "user_info": {
                    ...granter.getUserInfo(),
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": characterList,
                "equipment_list": granter.equipmentList,
                "item_list": granter.itemList,
                "degree_list": granter.degreeList.map(degreeId => ({ viewer_id: viewerId, degree_id: degreeId })),
                "mail_arrived": getPlayerMailCountSync(playerId, true) > 0
            }
        })
    })
}

export default routes;
