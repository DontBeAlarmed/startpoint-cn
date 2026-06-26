// Mission progress endpoints — get and update

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, getSession, getPlayerSync, getPlayerQuestProgressSync, updatePlayerActiveMissionSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { getCurrentStage, getMissionIdsByCategory, getMissionsByPattern, getTargetDegree, getMissionPattern, isComputablePattern, getCharacterStoryQuestId, getCharacterIdFromMission } from "../../lib/mission";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getRankDegree } from "../../lib/stamina";

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

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "Player not found."
        })

        const requestList = body.category_list || [{ category: 1 }]
        const requestCategories = requestList.map(c => c.category)
        console.log(`[MISSION] categories_full: ${JSON.stringify(body.category_list)}`)  // DEBUG
        const activeMissions = getPlayerActiveMissionsSync(playerId)
        const missionProgressList: any[] = []

        // Build category→character_id map for character-awake requests
        const categoryCharMap: Record<number, string | undefined> = {}
        for (const entry of requestList) {
            if ((entry as any).character_id !== undefined) {
                categoryCharMap[entry.category] = String((entry as any).character_id)
            }
        }

        // Pre-compute quest clear counts for server-side progress
        const questProgress = getPlayerQuestProgressSync(playerId)
        let totalQuestClears = 0
        let ssClears = 0; let sClears = 0; let aClears = 0; let bClears = 0
        for (const [section, quests] of Object.entries(questProgress)) {
            for (const qp of quests) {
                if (qp.finished) {
                    totalQuestClears++
                    if (qp.clearRank === 6) ssClears++
                    else if (qp.clearRank === 5) sClears++
                    else if (qp.clearRank === 4) aClears++
                    else if (qp.clearRank === 3) bClears++
                }
            }
        }

    const rankCounts: Record<string, number> = {
            'rank_ss': ssClears,
            'rank_s': sClears,
            'rank_a': aClears,
            'rank_b': bClears,
        }

        // Iterate CDN reward tables for each requested category
        for (const category of requestCategories) {
            const allIds = getMissionIdsByCategory(category)
            const charId = categoryCharMap[category]  // for category 9 filtering
            for (const missionId of allIds) {
                // Character-awake: filter by character_id from request
                if (charId && category === 9) {
                    const missionCharId = getCharacterIdFromMission(missionId)
                    if (missionCharId !== charId) continue
                }

                const mission = activeMissions[String(missionId)]
                // Compute server-side progress (official server behavior)
                let progress: number = mission?.progress ?? 0
                let computed = false

                if (category === 5) {
                    const targetDeg = getTargetDegree(missionId)
                    if (targetDeg !== undefined) {
                        progress = getRankDegree(player.rankPoint)
                        computed = true
                    }
                }

                // Character awakening story missions
                if (!computed && category === 9) {
                    const awakeCharId = getCharacterIdFromMission(missionId)
                    const questId = getCharacterStoryQuestId(awakeCharId)
                    if (questId !== undefined) {
                        const section = '3'  // character quests
                        const qpEntry = questProgress[section]?.find(q => q.questId === questId)
                        progress = qpEntry?.finished ? 1 : 0
                        computed = true
                    }
                }

                // Computable patterns for categories 1,2 (Regular + Daily)
                if (!computed && (category === 1 || category === 2)) {
                    const pattern = getMissionPattern(category, missionId)
                    if (pattern && isComputablePattern(pattern)) {
                        if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count')) {
                            progress = totalQuestClears
                        } else if (pattern.includes('stamina_use')) {
                            progress = player.totalStaminaUsed ?? 0
                        } else if (rankCounts[pattern] !== undefined) {
                            progress = rankCounts[pattern]
                        }
                    }
                }

                const stage = getCurrentStage(category, missionId, progress)
                missionProgressList.push({
                    mission_category: category,
                    mission_id: missionId,
                    progress_value: Number(progress),
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
