// Mission progress endpoints — get and update

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, getSession, updatePlayerActiveMissionSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { getCurrentStage, getMissionIdsByCategory, getMissionsByPattern } from "../../lib/mission";
import { resolvePlayerIdSync } from "../../data/activeAccount";

interface GetMissionProgressBody {
    api_count: number,
    viewer_id: number,
    category_list: {
        category: number
    }[]
}

interface UpdateMissionProgressBody {
    viewer_id: number,
    api_count: number,
    mission_param_list: {
        progress_value: number,
        mission_pattern: string
    }[]
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_mission_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetMissionProgressBody

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

        const requestCategories = body.category_list?.map(c => c.category) || [1, 2, 3, 5]
        const activeMissions = getPlayerActiveMissionsSync(playerId)
        const missionProgressList: any[] = []

        // Iterate CDN reward tables for each requested category — aligns with DummyMissionRepository.createDummyData()
        for (const category of requestCategories) {
            const allIds = getMissionIdsByCategory(category)
            for (const missionId of allIds) {
                const mission = activeMissions[String(missionId)]
                const progress = mission?.progress ?? 0
                const stage = getCurrentStage(category, missionId, progress)
                missionProgressList.push({
                    mission_category: category,
                    mission_id: missionId,
                    progress_value: Number(progress),  // Float type required by client (Std.is Number)
                    stage: stage
                })
            }
        }

        console.log(`[MISSION] get_progress viewer=${viewerId} categories=${requestCategories} missions=${missionProgressList.length}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mission_progress_list": missionProgressList,
                "mail_arrived": false
            }
        })
    })

    fastify.post("/update_mission_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateMissionProgressBody

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

        // Update mission progress counters in DB (fire-and-forget from client)
        const missionParams = body.mission_param_list || []
        let updatedCount = 0

        for (const param of missionParams) {
            const matches = getMissionsByPattern(param.mission_pattern)
            for (const m of matches) {
                updatePlayerActiveMissionSync(playerId, m.missionId, param.progress_value)
                updatedCount++
            }
        }

        console.log(`[MISSION] update_progress viewer=${viewerId} params=${missionParams.length} db_updates=${updatedCount}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mission_info": [],
                "degree_list": [],
                "mail_arrived": false
            }
        })
    })
}

export default routes;
