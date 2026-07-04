// Mission progress endpoints: get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, updatePlayerActiveMissionStageSync, updatePlayerActiveMissionSync } from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { givePlayerItemSync } from "../../data/domains/item"
import { insertDefaultPlayerCharacterSync } from "../../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { generateDataHeaders, getServerTime } from "../../utils";
import {
    getActiveMissionRewards,
    getAwakeMissionRewards,
    getCollectMissionRewards,
    getCompletedStageNumbers,
    getComputer,
    getCurrentStage,
    getDailyMissionRewards,
    getDegreeMissionRewards,
    getEventMissionRewards,
    getMissionIdsByCategory,
    getMissionsByPattern,
    getRegularMissionRewards,
    getWeeklyMissionRewards,
    getCharacterIdFromMission,
} from "../../lib/mission/index";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import type { ActiveMissionReward, CategoryContext } from "../../lib/mission/index";

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
        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "Player not found."
        })

        const missionProgressList: any[] = []
        const receivedStageKeys = new Set<string>()
        const itemRewards: Record<number, number> = {}
        let freeVmoney = player.freeVmoney
        let freeMana = player.freeMana
        let expPool = player.expPool
        let totalManaGained = 0

        for (const [missionId, mission] of Object.entries(activeMissions)) {
            const stages = mission.stages
            if (!stages || Array.isArray(stages)) continue
            for (const [stage, received] of Object.entries(stages)) {
                if (received) receivedStageKeys.add(`${missionId}:${stage}`)
            }
        }

        function getRewards(category: number, missionId: number, stage: number): ActiveMissionReward[] {
            if (category === 1) return getRegularMissionRewards(missionId, stage)
            if (category === 2) return getDailyMissionRewards(missionId, stage)
            if (category === 9) return getAwakeMissionRewards(missionId, stage)
            if (category === 3) return getEventMissionRewards(missionId, stage)
            if (category === 4) return getCollectMissionRewards(missionId, stage)
            if (category === 5) return getDegreeMissionRewards(missionId, stage)
            if (category === 10) return getWeeklyMissionRewards(missionId, stage)
            return getActiveMissionRewards(missionId, stage)
        }

        function applyRewards(rewards: ActiveMissionReward[]) {
            for (const r of rewards) {
                switch (r.kind) {
                    case 0:
                        freeVmoney += r.amount
                        break
                    case 1:
                        if (r.itemId) {
                            const newTotal = givePlayerItemSync(playerId, r.itemId, r.amount)
                            itemRewards[r.itemId] = newTotal
                        }
                        break
                    case 2:
                        if (r.equipmentId) {
                            const newTotal = givePlayerItemSync(playerId, r.equipmentId, r.amount)
                            itemRewards[r.equipmentId] = newTotal
                        }
                        break
                    case 3:
                        freeMana += r.amount
                        totalManaGained += r.amount
                        break
                    case 4:
                        if (r.characterId && r.amount > 0) {
                            try { insertDefaultPlayerCharacterSync(playerId, r.characterId) } catch (_) {}
                        }
                        break
                    case 5:
                        expPool += r.amount
                        break
                }
            }
        }

        // Build category-to-character_id filter map
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

                // Auto-grant rewards for newly completed stages.
                const completedStages = getCompletedStageNumbers(category, missionId, progress)
                const skipAutoGrant = category === 10

                if (!skipAutoGrant) for (const s of completedStages) {
                    const stageKey = `${missionId}:${s}`
                    if (receivedStageKeys.has(stageKey)) continue
                    updatePlayerActiveMissionSync(playerId, missionId, progress)
                    updatePlayerActiveMissionStageSync(playerId, s, missionId, true)
                    receivedStageKeys.add(stageKey)
                    applyRewards(getRewards(category, missionId, s))
                }

                missionProgressList.push({
                    mission_category: category,
                    mission_id: missionId,
                    progress_value: Number(progress),
                    stage: stage
                })
            }
        }

        const playerChanged = freeVmoney !== player.freeVmoney || freeMana !== player.freeMana || expPool !== player.expPool
        if (playerChanged) {
            updatePlayerSync({
                id: playerId,
                freeVmoney,
                freeMana,
                expPool,
                totalManaObtained: (player.totalManaObtained ?? 0) + totalManaGained
            })
        }

        console.log(`[MISSION] get_progress viewer=${viewerId} categories=${requestCategories} missions=${missionProgressList.length}`)

        const responseData: Record<string, any> = {
            "mission_progress_list": missionProgressList
        }
        if (playerChanged) {
            responseData["user_info"] = {
                "free_vmoney": freeVmoney,
                "free_mana": freeMana,
                "exp_pool": expPool,
                "exp_pooled_time": getServerTime(player.expPooledTime)
            }
        }
        if (Object.keys(itemRewards).length > 0) {
            responseData["item_list"] = itemRewards
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData
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
