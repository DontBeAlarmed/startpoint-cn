// Mission progress endpoints — get and update

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, getSession, getPlayerSync, getPlayerQuestProgressSync, getPlayerCharacterClearSync, givePlayerItemSync, insertDefaultPlayerCharacterSync, updatePlayerSync, updatePlayerActiveMissionSync, updatePlayerActiveMissionStageSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { getCurrentStage, getMissionIdsByCategory, getMissionsByPattern, getTargetDegree, getMissionPattern, isComputablePattern, getCharacterStoryQuestIds, getCharacterIdFromMission, getActiveMissionRewards, getAwakeMissionRewards, getCompletedStageNumbers } from "../../lib/mission";
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

// Compute context — pre-computed values shared by all mission computers
interface ComputeContext {
    player: ReturnType<typeof getPlayerSync> extends infer T | null ? NonNullable<T> : never
    questProgress: ReturnType<typeof getPlayerQuestProgressSync>
    rankCounts: Record<string, number>
    totalQuestClears: number
    totalStories: number      // finished section=3 quests (for Alk type_2)
}

function buildContext(playerId: number): ComputeContext {
    const player = getPlayerSync(playerId)!
    const questProgress = getPlayerQuestProgressSync(playerId)
    let totalQuestClears = 0, ssClears = 0, sClears = 0, aClears = 0, bClears = 0, totalStories = 0
    for (const [section, quests] of Object.entries(questProgress)) {
        for (const qp of quests) {
            if (qp.finished) {
                totalQuestClears++
                if (section === '3') totalStories++
                if (qp.clearRank === 6) ssClears++
                else if (qp.clearRank === 5) sClears++
                else if (qp.clearRank === 4) aClears++
                else if (qp.clearRank === 3) bClears++
            }
        }
    }
    return {
        player,
        questProgress,
        totalQuestClears,
        totalStories,
        rankCounts: { rank_ss: ssClears, rank_s: sClears, rank_a: aClears, rank_b: bClears },
    }
}

// Category-specific mission progress computers
function computeProgress(category: number, missionId: number, ctx: ComputeContext, dbProgress: number): number {
    // Degree missions
    if (category === 5) {
        const targetDeg = getTargetDegree(missionId)
        if (targetDeg !== undefined) return getRankDegree(ctx.player.rankPoint)
    }

    // Character awakening missions
    if (category === 9) {
        const charId = getCharacterIdFromMission(missionId)
        const clears = getPlayerCharacterClearSync(ctx.player.id, Number(charId))
        const storyQuestIds = getCharacterStoryQuestIds(charId)
        const lastDigit = missionId % 10

        if (lastDigit === 1) {
            // Story reading OR party member clears (14 simple chars have no story quests)
            const storyIds = getCharacterStoryQuestIds(charId)
            if (storyIds.length === 0) {
                return clears.clear_count  // "队伍中编有X通关" type missions
            }
            let count = 0
            for (const qid of storyIds) {
                if (ctx.questProgress['3']?.find(q => q.questId === qid)?.finished) count++
            }
            return count
        }
        if (lastDigit === 2) {
            if (charId === '1') return ctx.totalStories  // Alk: total all-character stories
            return clears.clear_count                       // Others: party member clears
        }
        if (lastDigit === 3) {
            if (charId === '1') return ctx.player.totalPowerflips ?? 0  // Alk: power flips
            return clears.clear_count      // Others: party member clears
        }
        if (lastDigit === 4) {
            // All complete: check directly via recursive calls for types 1-3
            const s1 = computeProgress(category, missionId - 3, ctx, dbProgress)
            const s2 = computeProgress(category, missionId - 2, ctx, dbProgress)
            const s3 = computeProgress(category, missionId - 1, ctx, dbProgress)
            return (s1 >= 1 && s2 >= 1 && s3 >= 1) ? 1 : 0
        }
    }

    // Computable patterns for categories 1,2 (Regular + Daily)
    if (category === 1 || category === 2) {
        const pattern = getMissionPattern(category, missionId)
        if (pattern && isComputablePattern(pattern)) {
            if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count')) return ctx.totalQuestClears
            if (pattern.includes('stamina_use')) return ctx.player.totalStaminaUsed ?? 0
            if (ctx.rankCounts[pattern] !== undefined) return ctx.rankCounts[pattern]
        }
    }

    // Fallback to DB-stored progress
    return dbProgress
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

        const ctx = buildContext(playerId)
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
            const allIds = getMissionIdsByCategory(category)
            const charId = categoryCharMap[category]
            for (const missionId of allIds) {
                // Character-awake: filter by character_id
                if (charId && category === 9) {
                    if (getCharacterIdFromMission(missionId) !== charId) continue
                }

                const dbProgress = activeMissions[String(missionId)]?.progress ?? 0
                const progress = computeProgress(category, missionId, ctx, dbProgress)
                const stage = getCurrentStage(category, missionId, progress)

                // Auto-grant rewards for newly completed stages
                const completedStages = getCompletedStageNumbers(category, missionId, progress)
                const existingStages = activeMissions[String(missionId)]?.stages
                const isRecord = existingStages && !Array.isArray(existingStages)
                for (const s of completedStages) {
                    if (isRecord && (existingStages as Record<string, boolean>)[String(s)]) continue
                    updatePlayerActiveMissionSync(playerId, missionId, progress)
                    updatePlayerActiveMissionStageSync(playerId, s, missionId, true)
                    const rewards = category === 9
                        ? getAwakeMissionRewards(missionId, s)
                        : getActiveMissionRewards(missionId, s)
                    for (const r of rewards) {
                        if (r.kind === 1 || r.kind === 2) {
                            givePlayerItemSync(playerId, (r.itemId || r.equipmentId)!, r.amount)
                        } else if (r.kind === 3) {
                            updatePlayerSync({ id: playerId, freeMana: (ctx.player.freeMana ?? 0) + r.amount })
                        } else if (r.kind === 4 && r.characterId) {
                            try { insertDefaultPlayerCharacterSync(playerId, r.characterId) } catch (_) {}
                        } else if (r.kind === 5) {
                            updatePlayerSync({ id: playerId, expPool: (ctx.player.expPool ?? 0) + r.amount })
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
