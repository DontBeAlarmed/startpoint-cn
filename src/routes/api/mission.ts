// Mission progress endpoints — get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCategoryMissionsSync, incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { generateDataHeaders, getServerTime } from "../../utils";
import { getComputer, getMissionIdsByCategory, getMissionsByPattern, getCurrentStage, getCharacterIdFromMission, isMissionEnabledAt, reconcileAwakeUnlockCharacterList, settleAwakeMissionRewards } from "../../lib/mission/index";
import type { AwakeMissionComputedProgress, AwakeMissionInfo } from "../../lib/mission/index";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import type { CategoryContext } from "../../lib/mission/index";
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
        const evaluationTime = new Date(getServerTime() * 1000)
        const categoryMissionCache = new Map<number, ReturnType<typeof getPlayerCategoryMissionsSync>>()
        const awakeProgressByCharacter = new Map<string, AwakeMissionComputedProgress[]>()

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

                if (category === 9 && charId !== undefined) {
                    const awakeProgress = awakeProgressByCharacter.get(charId) ?? []
                    awakeProgress.push({ missionId, progress: Number(progress) })
                    awakeProgressByCharacter.set(charId, awakeProgress)
                }
            }
        }

        console.log(`[MISSION] get_progress viewer=${viewerId} categories=${requestCategories} missions=${missionProgressList.length}`)

        const missionInfo: AwakeMissionInfo[] = []
        const itemList: Record<string, number> = {}
        const characterList: Record<string, unknown>[] = []
        const equipmentList: Object[] = []
        const degreeIds: number[] = []
        let userInfo: Record<string, number> | undefined

        for (const awakeProgress of awakeProgressByCharacter.values()) {
            const settlement = settleAwakeMissionRewards(playerId, awakeProgress)
            missionInfo.push(...settlement.missionInfo)
            Object.assign(itemList, settlement.itemList)
            characterList.push(...settlement.characterList)
            equipmentList.push(...settlement.equipmentList)
            for (const degreeId of settlement.degreeIds) {
                if (!degreeIds.includes(degreeId)) degreeIds.push(degreeId)
            }
            if (settlement.userInfo) userInfo = settlement.userInfo
        }

        const responseData: Record<string, unknown> = {
            mission_progress_list: missionProgressList,
            mission_info: missionInfo,
            item_list: itemList,
            character_list: characterList,
            equipment_list: equipmentList,
            degree_list: degreeIds.map(degreeId => ({ viewer_id: viewerId, degree_id: degreeId })),
            mail_arrived: false,
        }
        if (userInfo) responseData.user_info = userInfo

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

        const characterList = reconcileAwakeUnlockCharacterList(playerId, [])
        console.log(`[MISSION] update_progress viewer=${viewerId} params=${missionParams.length} db_updates=${updatedCount}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mission_info": [],
                "degree_list": [],
                character_list: characterList,
                "mail_arrived": false
            }
        })
    })
}

export default routes;
