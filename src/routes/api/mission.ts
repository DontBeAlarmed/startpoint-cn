// Mission progress endpoints — get and update
// Uses lib/mission/ computer registry for compute dispatch

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { incrementPlayerCategoryMissionIfSafeSync } from "../../data/domains/mission"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { generateDataHeaders, getServerTime } from "../../utils";
import { createCharacterAwakeEligibilityResolver, evaluateMissionProgressStageB, getCharacterIdFromMission, getCurrentStage, getMissionCatalog, settleAwakeMissionCandidatesWithEvaluation, settleMissionCategories, settleMissionCategoriesWithEvaluation } from "../../lib/mission/index";
import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "../../lib/mission/response-fragment";
import { projectCharacterPatch } from "../../lib/common-response/entities";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { resolveClientProgressTargets } from "../../lib/mission/client-progress";
import { resolvePlayerIdSync } from "../../data/activeAccount";
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

        const requestList = body.category_list || [{ category: 1 }]
        const requestCategories = requestList.map(c => c.category)
        const { responseData } = getDb().transaction(() => {
            const evaluationTime = new Date(getServerTime() * 1000)
            const awakeEligibility = requestList.some(entry => entry.category === 9)
                ? createCharacterAwakeEligibilityResolver(playerId, evaluationTime)
                : null

            const automaticScopes = requestList
                .filter(entry => [1, 2, 3, 4, 5, 6, 7, 8, 10].includes(entry.category))
                .map(entry => ({ category: entry.category, eventId: entry.event_id }))
            const automaticSettlement = automaticScopes.length > 0
                ? settleMissionCategoriesWithEvaluation(playerId, automaticScopes, evaluationTime)
                : null
            const stageB = automaticSettlement
                ? evaluateMissionProgressStageB(automaticSettlement)
                : null
            const standardProgressByMission = new Map<string, { progress: number, stage: number }>()
            for (const mission of automaticSettlement?.evaluation.missions ?? []) {
                standardProgressByMission.set(`${mission.category}:${mission.missionId}`, {
                    progress: mission.finalProgress,
                    stage: getCurrentStage(mission.category, mission.missionId, mission.finalProgress),
                })
            }
            for (const mission of stageB?.missions ?? []) {
                standardProgressByMission.set(`${mission.category}:${mission.missionId}`, {
                    progress: mission.finalProgress,
                    stage: getCurrentStage(mission.category, mission.missionId, mission.finalProgress),
                })
            }
            const missionProgressList: any[] = []
            const catalog = awakeEligibility === null ? null : getMissionCatalog()
            const awakeCandidatesByRequest = requestList.map(requestEntry => {
                if (requestEntry.category !== 9 || catalog === null) return []
                const characterId = requestEntry.character_id
                if (typeof characterId !== "number"
                    || !Number.isSafeInteger(characterId)
                    || characterId <= 0) return []
                const candidateIds = catalog.getAwakeMissionIdsByCharacter(characterId)
                return candidateIds.filter(missionId => (
                    catalog.isEnabledAt(9, missionId, evaluationTime, requestEntry.event_id)
                    && awakeEligibility!.isNewUnlockEligible(
                        Number(getCharacterIdFromMission(missionId)),
                        missionId,
                    )
                ))
            })
            const awakeMissionIds = [...new Set(awakeCandidatesByRequest.flat())]
            const awakeSettlement = awakeEligibility === null
                ? null
                : settleAwakeMissionCandidatesWithEvaluation(
                    playerId,
                    awakeMissionIds,
                    evaluationTime,
                    awakeEligibility,
                )
            const awakeProgressByMission = new Map(
                (awakeSettlement?.evaluation.missions ?? []).map(mission => [mission.missionId, mission]),
            )
            const awakeGrowthCharacterList = awakeSettlement === null
                ? []
                : publishCharacterGrowthOwnerStateBestEffort(
                    playerId,
                    [],
                    [awakeSettlement.settlement.characterList as Record<string, unknown>[]],
                    {
                        evaluatedAwakeUnlocks: {
                            progressList: awakeSettlement.evaluation.missions.map(mission => ({
                                missionId: mission.missionId,
                                progress: mission.finalProgress,
                            })),
                            resolver: awakeSettlement.resolver,
                        },
                    },
                    "mission/get_mission_progress",
                    evaluationTime,
                ).characterList
            const automaticMissionIdsByRequest = requestList.map(requestEntry => (
                automaticSettlement?.prepared.scopes.find(scope => (
                    scope.category === requestEntry.category
                    && scope.eventId === requestEntry.event_id
                ))?.enabledMissionIds ?? []
            ))

            for (let requestIndex = 0; requestIndex < requestList.length; requestIndex++) {
                const requestEntry = requestList[requestIndex]
                const category = requestEntry.category
                const allIds = category === 9
                    ? awakeCandidatesByRequest[requestIndex]
                    : automaticMissionIdsByRequest[requestIndex]

                for (const missionId of allIds) {
                    if (category !== 9) {
                        const progress = standardProgressByMission.get(`${category}:${missionId}`)
                        if (!progress) continue
                        missionProgressList.push({
                            mission_category: category,
                            mission_id: missionId,
                            progress_value: Number(progress.progress),
                            stage: progress.stage,
                        })
                        continue
                    }

                    const mission = awakeProgressByMission.get(missionId)
                    if (!mission) continue

                    missionProgressList.push({
                        mission_category: category,
                        mission_id: missionId,
                        progress_value: Number(mission.finalProgress),
                        stage: getCurrentStage(category, missionId, mission.finalProgress),
                    })
                }
            }

            const awakeResult = awakeSettlement?.settlement

            const responseData: Record<string, unknown> = {
                mission_progress_list: missionProgressList,
                ...mergeCommonResponseFragments([{
                    mission_info: [],
                    item_list: {},
                    character_list: [],
                    equipment_list: [],
                }]),
                degree_list: [],
            }
            if (automaticSettlement) {
                composeMissionSettlementResponse(
                    responseData,
                    projectMissionSettlementFragment(automaticSettlement.settlement),
                    viewerId,
                )
            }
            if (awakeResult) {
                const awakeFragment = projectMissionSettlementFragment(awakeResult)
                composeMissionSettlementResponse(
                    responseData,
                    awakeGrowthCharacterList.length > 0
                        ? {
                            ...awakeFragment,
                            common: {
                                ...awakeFragment.common,
                                character_list: awakeGrowthCharacterList.map(
                                    projectCharacterPatch,
                                ),
                            },
                        }
                        : awakeFragment,
                    viewerId,
                )
            }
            responseData.mission_info = [
                ...(awakeResult?.missionInfo ?? []),
                ...(automaticSettlement?.settlement.missionInfo ?? []),
            ]
            responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0
            return { responseData }
        })()


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
        const evaluationTime = new Date(getServerTime() * 1000)
        const awakeCandidateCharacterIds: number[] = []
        const automaticMissionIdsByCategory = new Map<number, Set<number>>()

        const automaticSettlement = getDb().transaction(() => {
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
                    )) {
                        if (match.category === 9) {
                            const characterId = Number(getCharacterIdFromMission(match.missionId))
                            if (Number.isSafeInteger(characterId) && characterId > 0) {
                                awakeCandidateCharacterIds.push(characterId)
                            }
                        } else {
                            const missionIds = automaticMissionIdsByCategory.get(match.category)
                                ?? new Set<number>()
                            missionIds.add(match.missionId)
                            automaticMissionIdsByCategory.set(match.category, missionIds)
                        }
                    }
                }
            }
            const scopes = [...automaticMissionIdsByCategory].map(([category, missionIds]) => ({
                category,
                missionIds: [...missionIds],
            }))
            return scopes.length > 0
                ? settleMissionCategories(playerId, scopes, evaluationTime)
                : null
        })()

        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            awakeCandidateCharacterIds,
            [[]],
            {},
            "mission/update_mission_progress",
        ).characterList

        const responseData: Record<string, unknown> = {
            ...mergeCommonResponseFragments([{
                mission_info: [],
                character_list: characterList.map(
                    character => projectCharacterPatch(character),
                ),
                item_list: {},
                equipment_list: [],
                mail_arrived: getPlayerMailCountSync(playerId, true) > 0,
            }]),
            degree_list: [],
        }
        if (automaticSettlement) {
            composeMissionSettlementResponse(
                responseData,
                projectMissionSettlementFragment(automaticSettlement),
                viewerId,
            )
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData,
        })
    })
}

export default routes;
