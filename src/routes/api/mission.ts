// Mission progress endpoints — get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerCategoryMissionsSync,
    incrementPlayerCategoryMissionIfSafeSync,
} from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { generateDataHeaders, getServerTime } from "../../utils";
import { createCharacterAwakeEligibilityResolver, getComputer, getMissionIdsByCategory, getCurrentStage, getCharacterIdFromMission, isMissionEnabledAt, mergeMissionSettlementResponse, reconcileAwakeUnlockCharacterList, settleAwakeMissionRewards, settleMissionCategories } from "../../lib/mission/index";
import { resolveClientProgressTargets } from "../../lib/mission/client-progress";
import type { AwakeMissionComputedProgress, AwakeMissionInfo } from "../../lib/mission/index";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import type { CategoryContext } from "../../lib/mission/index";
import { addMissionProgressDelta } from "../../lib/mission/progress";
import { buildAwakeContext } from "../../lib/mission/computer-awake";

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
                const ctx = category === 9 && awakeEligibility
                    ? buildAwakeContext(playerId, awakeEligibility.characters) as CategoryContext
                    : computer.buildContext(playerId, category, evaluationTime) as CategoryContext
                entry = { ctx }
                computerCache.set(category, entry)
            }
            return entry.ctx
        }

        const requestList = body.category_list || [{ category: 1 }]
        const requestCategories = requestList.map(c => c.category)
        const evaluationTime = new Date(getServerTime() * 1000)
        const awakeEligibility = requestList.some(entry => entry.category === 9)
            ? createCharacterAwakeEligibilityResolver(playerId, evaluationTime)
            : null
        const automaticScopes = requestList
            .filter(entry => [1, 2, 3, 4, 5, 6, 7, 8, 10].includes(entry.category))
            .map(entry => ({ category: entry.category, eventId: entry.event_id }))
        const automaticSettlement = automaticScopes.length > 0
            ? settleMissionCategories(playerId, automaticScopes, evaluationTime)
            : null
        const missionProgressList: any[] = []
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
            const charId = requestEntry.character_id === undefined ? undefined : String(requestEntry.character_id)
            const candidateIds = category === 9 && charId !== undefined
                ? getMissionIdsByCategory(category).filter(missionId =>
                    getCharacterIdFromMission(missionId) === charId
                )
                : getMissionIdsByCategory(category)
            const allIds = candidateIds.filter(missionId =>
                isMissionEnabledAt(category, missionId, evaluationTime, requestEntry.event_id)
                && (category !== 9 || awakeEligibility!.isNewUnlockEligible(
                    Number(getCharacterIdFromMission(missionId)),
                    missionId,
                ))
            )

            for (const missionId of allIds) {
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
            const settlement = settleAwakeMissionRewards(playerId, awakeProgress, awakeEligibility!)
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
        }
        if (userInfo) responseData.user_info = userInfo
        if (automaticSettlement) {
            mergeMissionSettlementResponse(
                responseData,
                automaticSettlement,
                viewerId,
            )
        }
        responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData
        })
    })

    fastify.post("/update_mission_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.body === null
            || typeof request.body !== "object"
            || Array.isArray(request.body)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const body = request.body as Partial<UpdateMissionProgressBody>

        const viewerId = body.viewer_id
        if (typeof viewerId !== "number"
            || !Number.isSafeInteger(viewerId)
            || viewerId <= 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // Update mission progress counters in DB (fire-and-forget from client)
        const missionParams = Array.isArray(body.mission_param_list)
            ? body.mission_param_list
            : []
        let updatedCount = 0
        const evaluationTime = new Date(getServerTime() * 1000)

        getDb().transaction(() => {
            for (const param of missionParams) {
                if (param === null || typeof param !== "object" || Array.isArray(param)) continue
                const delta = addMissionProgressDelta(0, param.progress_value)
                if (typeof param.mission_pattern !== "string" || delta === null) continue
                const matches = resolveClientProgressTargets(
                    param.mission_pattern,
                    evaluationTime,
                )
                for (const match of matches) {
                    if (incrementPlayerCategoryMissionIfSafeSync(
                        playerId,
                        match.category,
                        match.missionId,
                        delta,
                    )) updatedCount++
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
                "mail_arrived": getPlayerMailCountSync(playerId, true) > 0
            }
        })
    })
}

export default routes;
