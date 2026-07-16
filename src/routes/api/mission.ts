// Mission progress endpoints — get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCategoryMissionsSync, incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getDb } from "../../data/db"
import { generateDataHeaders, getServerTimeForPlayer } from "../../utils";
import { computeAwakeSummary, getComputer, getMissionIdsByCategory, getMissionsByPattern, getCurrentStage, getCharacterIdFromMission, isMissionEnabledAt } from "../../lib/mission/index";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import type { CategoryContext } from "../../lib/mission/index";
import { buildManaBoardAwakeCharacterList } from "../../lib/character-helpers";
import { addMissionProgressDelta } from "../../lib/mission/progress";

interface GetMissionProgressBody {
    api_count: number,
    viewer_id: number,
    category_list: {
        category: number,
        event_id?: number,
        character_id?: number
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
        const missionProgressList: any[] = []
        const evaluationTime = new Date(getServerTimeForPlayer(playerId) * 1000)
        const categoryMissionCache = new Map<number, ReturnType<typeof getPlayerCategoryMissionsSync>>()

        for (const requestEntry of requestList) {
            const category = requestEntry.category
            const computer = getComputer(category)
            const ctx = getCtx(category)
            let categoryMissions = categoryMissionCache.get(category)
            if (!categoryMissions) {
                categoryMissions = getPlayerCategoryMissionsSync(playerId, category)
                categoryMissionCache.set(category, categoryMissions)
            }
            const allIds = getMissionIdsByCategory(category).filter(missionId =>
                isMissionEnabledAt(category, missionId, evaluationTime, requestEntry.event_id)
            )
            const charId = requestEntry.character_id === undefined ? undefined : String(requestEntry.character_id)

            for (const missionId of allIds) {
                // Character-awake: filter by character_id
                if (charId && category === 9) {
                    if (getCharacterIdFromMission(missionId) !== charId) continue
                }

                const dbProgress = categoryMissions[String(missionId)]?.progress ?? 0
                const progress = computer.compute(missionId, ctx, dbProgress)
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

        const awakeSummary = computeAwakeSummary(playerId)
        const awakeCharacterList = buildManaBoardAwakeCharacterList(
            getPlayerCharactersSync(playerId),
            awakeSummary.manaBoardAwakeMap
        )
        const responseData: Record<string, unknown> = {
            mission_progress_list: missionProgressList,
            character_list: awakeCharacterList,
            mail_arrived: false,
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

        getDb().transaction(() => {
            for (const param of missionParams) {
                const delta = addMissionProgressDelta(0, param.progress_value)
                if (typeof param.mission_pattern !== "string" || delta === null) continue
                const matches = getMissionsByPattern(param.mission_pattern)
                for (const match of matches) {
                    incrementPlayerCategoryMissionSync(playerId, match.category, match.missionId, delta)
                    updatedCount++
                }
            }
        })()

        console.log(`[MISSION] update_progress viewer=${viewerId} params=${missionParams.length} db_updates=${updatedCount}`)

        const awakeSummary = computeAwakeSummary(playerId)
        const awakeCharacterList = buildManaBoardAwakeCharacterList(
            getPlayerCharactersSync(playerId),
            awakeSummary.manaBoardAwakeMap
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mission_info": [],
                "degree_list": [],
                "character_list": awakeCharacterList,
                "mail_arrived": false
            }
        })
    })
}

export default routes;
