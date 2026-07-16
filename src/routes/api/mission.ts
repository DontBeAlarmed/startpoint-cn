// Mission progress endpoints — get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, updatePlayerActiveMissionStageSync, updatePlayerActiveMissionSync } from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { givePlayerItemSync } from "../../data/domains/item"
import { insertDefaultPlayerCharacterSync } from "../../data/domains/character"
import { updatePlayerSync } from "../../data/domains/player"
import { generateDataHeaders } from "../../utils";
import { getComputer, getMissionIdsByCategory, getMissionsByPattern, getCurrentStage, getActiveMissionRewards, getAwakeMissionRewards, getEventMissionRewards, getCompletedStageNumbers, getCharacterIdFromMission } from "../../lib/mission/index";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import type { CategoryContext } from "../../lib/mission/index";

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

        // Cache computer+context per category to avoid redundant builds
        const computerCache = new Map<number, { ctx: CategoryContext }>()

        function getCtx(category: number): CategoryContext {
            let entry = computerCache.get(category)
            if (!entry) {
                const computer = getComputer(category)
                const ctx = computer.buildContext(playerId, category) as CategoryContext
                entry = { ctx }
                computerCache.set(category, entry)
            }
            return entry.ctx
        }

        const requestList = body.category_list || [{ category: 1 }]
        const requestCategories = requestList.map(c => c.category)
        const activeMissions = getPlayerActiveMissionsSync(playerId)
        const missionProgressList: any[] = []

        // Build category→character_id filter map
        const categoryCharMap: Record<number, string | undefined> = {}
        for (const entry of requestList) {
            if ((entry as any).character_id !== undefined) {
                categoryCharMap[entry.category] = String((entry as any).character_id)
            }
        }

        for (const category of requestCategories) {
            const computer = getComputer(category)
            const ctx = getCtx(category)
            const allIds = getMissionIdsByCategory(category)
            const charId = categoryCharMap[category]

            for (const missionId of allIds) {
                // Character-awake: filter by character_id
                if (charId && category === 9) {
                    if (getCharacterIdFromMission(missionId) !== charId) continue
                }

                const dbProgress = activeMissions[String(missionId)]?.progress ?? 0
                const progress = computer.compute(missionId, ctx, dbProgress)
                const stage = getCurrentStage(category, missionId, progress)

                // Auto-grant rewards for newly completed stages (skip periodic categories)
                const completedStages = getCompletedStageNumbers(category, missionId, progress)
                const existingStages = activeMissions[String(missionId)]?.stages
                const isRecord = existingStages && !Array.isArray(existingStages)
                const skipAutoGrant = category === 2 || category === 10  // daily/weekly rewards via active_mission/receive

                let localMana = ctx.player.freeMana
                let localExp = ctx.player.expPool

                if (!skipAutoGrant) for (const s of completedStages) {
                    if (isRecord && (existingStages as Record<string, boolean>)[String(s)]) continue
                    updatePlayerActiveMissionSync(playerId, missionId, progress)
                    updatePlayerActiveMissionStageSync(playerId, s, missionId, true)
                    const rewards = category === 9
                        ? getAwakeMissionRewards(missionId, s)
                        : category === 3
                            ? getEventMissionRewards(missionId, s)
                            : getActiveMissionRewards(missionId, s)
                    for (const r of rewards) {
                        if (r.kind === 1 || r.kind === 2) {
                            givePlayerItemSync(playerId, (r.itemId || r.equipmentId)!, r.amount)
                        } else if (r.kind === 3) {
                            localMana += r.amount
                            updatePlayerSync({
                                id: playerId,
                                freeMana: localMana,
                                totalManaObtained: (ctx.player.totalManaObtained ?? 0) + (localMana - ctx.player.freeMana)
                            })
                        } else if (r.kind === 4 && r.characterId) {
                            try { insertDefaultPlayerCharacterSync(playerId, r.characterId) } catch (_) {}
                        } else if (r.kind === 5) {
                            localExp += r.amount
                            updatePlayerSync({ id: playerId, expPool: localExp })
                        }
                    }
                }

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
                "mission_progress_list": missionProgressList
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
                "degree_list": []
            }
        })
    })
}

export default routes;
