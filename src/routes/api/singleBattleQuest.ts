import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getPlayerActiveQuestSync } from "../../data/domains/quest_active"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { getQuestConfigurationErrorResponse, getQuestFromCategorySync } from "../../lib/assets"
import type { BattleQuest } from "../../lib/types"
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils"
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time"
import { computeRealTimeStamina } from "../../lib/stamina"
import { getStaminaCost } from "../../lib/stamina-cost"
import { dispatchModeQuestStart } from "../../modes/registry"
import { createModeHost } from "../../modes/loader"
import {
    validateSessionIdentity,
} from "../../lib/quest/finish/session-validator"
import { settleSingleBattleQuest } from "../../lib/quest/finish/single-orchestrator"
import { buildSingleFinishResponse } from "../../lib/quest/finish/single-response-projector"
import type { SingleFinishResponseHeaders } from "../../lib/quest/finish/single-response-projector"
import bundledQuestEntryCosts from "../../../assets/quest_entry_costs.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import {
    mergeMissionSettlementResponse,
    settleMissionCategories,
} from "../../lib/mission"
import type { MissionSettlementResult } from "../../lib/mission"
import { getDb } from "../../data/db"
import {
    ActiveQuestAlreadyExistsError,
    buildStartEntryItemList,
    InsufficientEntryItemError,
    InsufficientStaminaError,
    PlayerNotFoundError,
    runStartEntryTransaction,
    StartEntryCost,
} from "../../lib/quest/start-entry"
import {
    ActiveQuest,
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
    runAbortActiveQuestTransaction,
} from "../../lib/quest/active-quest-service"
import {
    AUTO_START_STOP_RESULT_CODE,
    shouldStopAutoStartForStamina,
} from "../../lib/quest/auto-start-stop"
import { getMailArrivedSync } from "../../lib/mail-notification"
import { recordActiveMissionQuestChallengeFactSync } from "../../lib/mission/active-entry-facts"
import { runSingleContinueLifecycleTransaction } from "../../lib/quest/single-continue-lifecycle"
import { validateAbortRequest } from "../../lib/quest/abort-request-validation"
import {
    validateSingleFinishRequest,
    type ValidatedSingleFinishBody,
} from "../../lib/quest/single-finish-validation"

const singleBattleModeHost = createModeHost(message => console.log(message))

interface StartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
}

interface QuestStatistics {
    clear_phase: number,
    continue_count: number,
    party: {
        unison_characters: ({ id: (number | null) } | null)[],
        characters: ({ id: (number | null) } | null)[],
        equipments: ({ id: (number | null) } | null)[],
        ability_soul_ids: (number | null)[],
        leader?: ({ id: (number | null) } | null)
    }
    zones?: {
        use_power_flip_count?: number
        use_dash_count?: number
        use_skill_count?: number
        damage_deal_total?: number
        members?: ({
            debuff_r?: number
            origin_damage?: number
            [key: string]: any
        } | null)[]
        [key: string]: any
    }[]
}

export type FinishBody = ValidatedSingleFinishBody

interface PlayContinueBody {
    api_count: number,
    payment_type: number,
    quest_id: number,
    viewer_id: number,
    play_id: string,
    category: number,
    statistics: QuestStatistics
}

function summarizeItemList(itemList: Record<string, number>): string {
    const entries = Object.entries(itemList)
    if (entries.length === 0) return "none"
    return entries.map(([itemId, amount]) => `${itemId}:${amount}`).join(",")
}

const continueVmoneyCost = 50;

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const validationResult = validateSingleFinishRequest(request.body)
        if (!validationResult.ok) return reply.status(400).send({
            "error": "Bad Request", "message": validationResult.message,
        })
        const body = validationResult.body

        const viewerId = body.viewer_id
        const sessionResult = await validateSessionIdentity(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId } = sessionResult

        const finishResult = settleSingleBattleQuest({
            playerId,
            memoryActiveQuest: activeQuests[playerId],
            body,
        })
        if (!finishResult.ok) {
            return reply.status(finishResult.statusCode).send(finishResult.payload)
        }
        const generatedDataHeaders: Record<string, unknown> = generateDataHeaders({ viewer_id: viewerId })
        const serverTime = generatedDataHeaders.servertime
        if (typeof serverTime !== "number") {
            throw new Error("Single finish response headers are missing servertime.")
        }
        const dataHeaders: SingleFinishResponseHeaders = {
            ...generatedDataHeaders,
            servertime: serverTime,
        }
        const response = buildSingleFinishResponse({
            result: finishResult,
            dataHeaders,
            player: {
                freeMana: finishResult.finalPlayerProjection.freeMana,
                expPool: finishResult.finalPlayerProjection.expPool,
                expPooledTime: expPoolRealDateToClientTimestamp(finishResult.finalPlayerProjection.expPooledTime),
                freeVmoney: finishResult.finalPlayerProjection.freeVmoney,
                rankPoint: finishResult.finalPlayerProjection.rankPoint,
                degreeId: finishResult.finalPlayerProjection.degreeId,
                stamina: finishResult.finalPlayerProjection.stamina,
                staminaHealTime: realToVirtual(finishResult.finalPlayerProjection.staminaHealTime),
                boostPoint: finishResult.finalPlayerProjection.boostPoint,
                bossBoostPoint: finishResult.finalPlayerProjection.bossBoostPoint,
            },
            mailArrived: getPlayerMailCountSync(playerId, true) > 0,
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(response)

    })

    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const sendBadRequest = (message: string) => {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(400).send({ "error": "Bad Request", message })
        }
        const validation = validateAbortRequest(request.body)
        if (!validation.ok) return sendBadRequest(validation.message)
        const { viewerId, playId, questId, category } = validation

        const sessionResult = await validateSessionIdentity(viewerId)
        if (!sessionResult) return sendBadRequest("Invalid viewer id.")
        const { playerId } = sessionResult

        const headers = generateDataHeaders({ viewer_id: viewerId })

        const abortResult = runAbortActiveQuestTransaction(playerId, {
            playId,
            questId,
            category,
        })
        const resolvedIdentity = abortResult.resolvedIdentity
        const observedActiveQuest = abortResult.observedActiveQuest
        console.log([
            "[SINGLE_ABORT]",
            `player=${playerId}`,
            `viewer=${viewerId}`,
            `missing_play=${playId === null}`,
            `missing_quest=${questId === null}`,
            `missing_category=${category === null}`,
            `active=${observedActiveQuest ? `${observedActiveQuest.category}_${observedActiveQuest.questId}` : "none"}`,
            `resolved=${resolvedIdentity.category}_${resolvedIdentity.questId}`,
            `cancelled=${abortResult.cancelled}`,
            `refund=${summarizeItemList(abortResult.itemList)}`,
        ].join(" "))

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": resolvedIdentity.category,
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": "",
                "item_list": abortResult.itemList
            }
        })
    })

    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody

        const viewerId = body.viewer_id
        const partyId = body.party_id
        const questId = body.quest_id
        const category = body.category
        const useBoostPoint = body.use_boost_point
        const useBossBoostPoint = body.use_boss_boost_point
        const isAutoStartMode = body.is_auto_start_mode
        if (isNaN(viewerId) || isNaN(partyId) || isNaN(questId) || isNaN(category) || useBoostPoint === undefined || useBossBoostPoint === undefined || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sessionResult = await validateSessionIdentity(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId } = sessionResult

        // get quest data
        let questData: BattleQuest | null
        try {
            questData = getQuestFromCategorySync(category, questId)
        } catch (error) {
            const configurationError = getQuestConfigurationErrorResponse(error)
            if (configurationError !== null) return reply.status(500).send(configurationError)
            throw error
        }
        if (questData === null || !('rankPointReward' in questData)) {
            console.log(`[BATTLE] start failed: category=${category} questId=${questId} found=${!!questData} hasRankReward=${questData ? ('rankPointReward' in questData) : 'N/A'}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest doesn't exist."
            })
        }

        // Mode seam: installed mode modules may veto the start (entry rules).
        try {
            dispatchModeQuestStart({ playerId, questId, questCategory: category }, singleBattleModeHost)
        } catch (error) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": (error as Error).message,
            })
        }

        // Validate and persist all quest-start state atomically.
        const questKey = `${category}_${questId}`
        const entryCost = getRuntimeContentTableSync(
            "quest_entry_costs.json",
            bundledQuestEntryCosts as Record<string, StartEntryCost>,
        )[questKey]
        const staminaInfo = getStaminaCost(questKey)
        console.log(`[BATTLE] start entry: questId=${questId} questKey=${questKey} entryCost=${JSON.stringify(entryCost)} discountRate=${staminaInfo.rate} baseStamina=${staminaInfo.baseCost}→${staminaInfo.cost}`)
        const staminaCost = staminaInfo.cost
        const activeQuest: ActiveQuest = {
            questId: questId,
            category: category,
            useBoostPoint: useBoostPoint,
            useBossBoostPoint: useBossBoostPoint,
            isAutoStartMode: isAutoStartMode,
            isMulti: false,
            coordinatorOrigin: null,
            entryItemId: entryCost && entryCost.itemId > 0 ? entryCost.itemId : undefined,
            entryItemCount: entryCost && entryCost.itemCount > 0 ? entryCost.itemCount : undefined,
            playId: body.play_id,
            continueCount: 0
        }
        const startTime = new Date()
        let startResult
        let missionSettlement: MissionSettlementResult | undefined
        try {
            startResult = runStartEntryTransaction({
                playerId,
                entryCost,
                staminaCost,
                partyId,
                updatePartySlot: questData.fixedParty === undefined,
                activeQuest,
                now: startTime,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getActiveQuest: getPlayerActiveQuestSync,
                getPlayer: getPlayerSync,
                computeStamina: computeRealTimeStamina,
                getItemCount: getPlayerItemSync,
                updateItemCount: updatePlayerItemSync,
                updatePlayer: updatePlayerSync,
                persistActiveQuest,
                afterPersist: () => {
                    recordActiveMissionQuestChallengeFactSync(playerId, category)
                    missionSettlement = settleMissionCategories(
                        playerId,
                        [1, 2, 10],
                        new Date(getServerTime() * 1000),
                    )
                },
                publishActiveQuest,
            })
        } catch (error) {
            if (error instanceof ActiveQuestAlreadyExistsError
                || error instanceof InsufficientEntryItemError
                || error instanceof InsufficientStaminaError
                || error instanceof PlayerNotFoundError) {
                console.warn(`[BATTLE-START] player ${playerId}: ${error.message}`)
                if (error instanceof InsufficientStaminaError
                    && shouldStopAutoStartForStamina(isAutoStartMode, true)) {
                    reply.header("content-type", "application/x-msgpack")
                    return reply.status(200).send({
                        "data_headers": generateDataHeaders({
                            viewer_id: viewerId,
                            result_code: AUTO_START_STOP_RESULT_CODE,
                        }),
                        "data": {},
                    })
                }
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }
        console.log(`[BATTLE-START] stamina: ${startResult.beforeStamina} -> ${startResult.afterStamina} (cost: ${staminaCost}, rate: ${staminaInfo.rate})`)

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, any> = {
                "user_info": {
                    "last_main_quest_id": body.quest_id,
                    "stamina": startResult.afterStamina,
                    "stamina_heal_time": realToVirtual(startTime)
                },
                "item_list": buildStartEntryItemList(startResult),
                "category_id": body.category,
                "is_multi": "single",
                "start_time": dataHeaders['servertime'],
                "quest_name": ""
        }
        if (missionSettlement) {
            mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)
        }
        responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": responseData,
        })
    })

    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const sendBadRequest = (message: string) => {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(400).send({ "error": "Bad Request", message })
        }
        const rawBody = request.body
        if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
            return sendBadRequest("Invalid request body.")
        }
        const body = rawBody as PlayContinueBody

        const viewerId = body.viewer_id
        if (
            !Number.isSafeInteger(viewerId)
            || !Number.isSafeInteger(body.quest_id)
            || !Number.isSafeInteger(body.category)
            || typeof body.play_id !== "string"
            || body.play_id.length === 0
            || body.payment_type !== 1
            || typeof body.statistics !== "object"
            || body.statistics === null
            || !Number.isSafeInteger(body.statistics.continue_count)
            || body.statistics.continue_count < 0
        ) return sendBadRequest("Invalid request body.")

        const sessionResult = await validateSessionIdentity(viewerId)
        if (!sessionResult) return sendBadRequest("Invalid viewer id.")
        const { playerId } = sessionResult

        const continueResult = runSingleContinueLifecycleTransaction({
            playerId,
            memoryQuest: activeQuests[playerId],
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
            expectedContinueCount: body.statistics.continue_count,
            cost: continueVmoneyCost,
        })
        if (!continueResult.ok) return sendBadRequest(continueResult.message)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_vmoney": continueResult.freeVmoney,
                    "vmoney": continueResult.vmoney
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })

    })
}

export default routes;
