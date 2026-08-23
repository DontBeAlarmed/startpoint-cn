import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, insertReceiveHistorySync } from "../../data/domains/mail"
import { getPlayerGachaCampaignSync, getPlayerGachaInfoListSync, getPlayerGachaInfoSync, insertPlayerGachaCampaignSync, insertPlayerGachaInfoSync, updatePlayerGachaCampaignSync, updatePlayerGachaInfoSync } from "../../data/domains/gacha"
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { drawGachaWithMetadataSync, planCharacterGachaMovies, rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { getGachaCampaignIdSync, getGachaSync } from "../../lib/assets";
import { CharacterGacha, GachaType } from "../../lib/types";
import { serializeGachaCampaign } from "../../data/utils";
import { PlayerGachaCampaign, UserGachaCampaign } from "../../data/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import {
    incrementActiveMissionGachaCampaignCountSync,
    incrementActiveMissionGachaCharacterCountSync,
} from "../../data/domains/active_mission_counters"
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { buildGachaExecPlan } from "../../lib/gacha-exec-plan";
import { getExchangeableGachaItem } from "../../lib/gacha-rules";
import { publishAwakeCharacterListBestEffort } from "../../lib/mission/awake-best-effort-context";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";
import { executeRewardGrantPlanInTransactionOwnerInternalSync } from "../../lib/reward-grant/owner-executor";

interface ExecBody {
    api_count: number,
    payment_type: number,
    number_of_exec: number,
    viewer_id: number,
    gacha_id: number,
    type: number
}

interface ExchangeCharacterBody {
    character_id: number,
    api_count: number,
    gacha_id: number,
    viewer_id: number
}

interface ExchangeEquipmentBody {
    equipment_id: number,
    gacha_id: number,
    viewer_id: number,
    api_count: number
}

enum GachaPaymentType {
    EMPTY,
    FREE_VMONEY,
    VMONEY,
    TICKET,
    CAMPAIGN
}

enum GachaExecType {
    EMPTY,
    VMONEY_SINGLE,
    VMONEY_MULTI,
    UNKNOWN_1,
    UNKNOWN_2,
    DAILY_SINGLE,
    UNKNOWN_3,
    CAMPAIGN_SINGLE,
    CAMPAIGN_MULTI,
    MULTI_TICKET,
    SINGLE_TICKET,
    UNKNOWN_4,
    SINGLE_WEAPON_TICKET,
    MULTI_WEAPON_TICKET
}

const exchangeRequiredPoints = 250

class GachaExchangeRewardError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "GachaExchangeRewardError"
    }
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/exchange_equipment", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeEquipmentBody

        const equipmentId = body.equipment_id
        const gachaId = body.gacha_id
        const viewerId = body.viewer_id
        if (isNaN(viewerId) || isNaN(equipmentId) || isNaN(gachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get gacha info
        const gachaInfo = getPlayerGachaInfoSync(playerId, gachaId)
        if (gachaInfo === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No data for gacha with provided id."
        })

        const gachaData = getGachaSync(gachaId)
        if (gachaData === null || gachaData.type !== GachaType.WEAPON) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No equipment exchange data for gacha with provided id."
        })
        if (getExchangeableGachaItem(gachaData, equipmentId) === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Equipment is not exchangeable from this gacha."
        })

        const newExchangePoints = (gachaInfo.gachaExchangePoint ?? 0) - exchangeRequiredPoints
        if (0 > newExchangePoints) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough exchange points."
        })

        let giveResult!: ReturnType<typeof givePlayerEquipmentSync>
        getDb().transaction(() => {
            giveResult = givePlayerEquipmentSync(playerId, equipmentId, 1)
            insertReceiveHistorySync(playerId, { type: MailType.EQUIPMENT, type_id: equipmentId, number: 1 })
            updatePlayerGachaInfoSync(playerId, {
                gachaId: gachaId,
                gachaExchangePoint: newExchangePoints
            })
        })()

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "equipment_list": [
                    giveResult
                ],
                "gacha_info_list": [
                    {
                        "gacha_id": gachaId,
                        "is_account_first": gachaInfo.isAccountFirst,
                        "is_daily_first": gachaInfo.isDailyFirst,
                        "gacha_exchange_point": newExchangePoints
                    }
                ],
                "encyclopedia_info": [],
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })

    })

    fastify.post("/exchange_character", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeCharacterBody

        const characterId = body.character_id
        const gachaId = body.gacha_id
        const viewerId = body.viewer_id
        if (isNaN(viewerId) || isNaN(characterId) || isNaN(gachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get gacha info
        const gachaInfo = getPlayerGachaInfoSync(playerId, gachaId)
        if (gachaInfo === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No data for gacha with provided id."
        })

        const gachaData = getGachaSync(gachaId)
        if (gachaData === null || gachaData.type !== GachaType.CHARACTER) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No character exchange data for gacha with provided id."
        })
        if (getExchangeableGachaItem(gachaData, characterId) === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character is not exchangeable from this gacha."
        })

        const newExchangePoints = (gachaInfo.gachaExchangePoint ?? 0) - exchangeRequiredPoints
        if (0 > newExchangePoints) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough exchange points."
        })

        let giveResult!: NonNullable<ReturnType<typeof givePlayerCharacterSync>>
        try {
            getDb().transaction(() => {
                const result = givePlayerCharacterSync(playerId, characterId)
                if (result === null) {
                    throw new GachaExchangeRewardError("Could not give player character.")
                }
                giveResult = result
                insertReceiveHistorySync(playerId, { type: MailType.CHARACTER, type_id: characterId, number: 1 })
                updatePlayerGachaInfoSync(playerId, {
                    gachaId: gachaId,
                    gachaExchangePoint: newExchangePoints
                })
            })()
        } catch (error) {
            if (error instanceof GachaExchangeRewardError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }

        const existingCharacterList: Record<string, unknown>[] = giveResult.character
            ? [giveResult.character as Record<string, unknown>]
            : []
        const characterList = publishAwakeCharacterListBestEffort(
            playerId,
            [characterId],
            [existingCharacterList],
            {},
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": characterList,
                "item_list": giveResult.item !== undefined ? {
                    [giveResult.item.id]: giveResult.item.count
                } : [],
                "gacha_info_list": [
                    {
                        "gacha_id": gachaId,
                        "is_account_first": gachaInfo.isAccountFirst,
                        "is_daily_first": gachaInfo.isDailyFirst,
                        "gacha_exchange_point": newExchangePoints
                    }
                ],
                "encyclopedia_info": [],
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })

    })

    fastify.post("/exec", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExecBody

        const viewerId = body.viewer_id
        const gachaId = body.gacha_id
        const paymentType = body.payment_type
        const numberOfExec = body.number_of_exec
        const type = body.type
        if (isNaN(viewerId) || isNaN(gachaId) || isNaN(paymentType) || isNaN(numberOfExec) || isNaN(type)) {
            console.log(`[GACHA] Invalid body: v=${viewerId} g=${gachaId} pt=${paymentType} n=${numberOfExec} t=${type}`);
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        // get the gacha
        const gachaData = getGachaSync(gachaId)
        if (gachaData === null) {
            console.log(`[GACHA] Gacha not found: gachaId=${gachaId}`);
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Gacha doesn't exist."
            })
        }
        const isCharacterGacha = gachaData.type == GachaType.CHARACTER

        let gachaCampaigns: UserGachaCampaign[] = []
        let items: Record<number, number> = {}
        let playerPaidVmoney = 0
        let playerFreeVmoney = 0
        let newGachaExchangePoint = 0
        let rewardResult!: ReturnType<typeof rewardPlayerGachaDrawResultSync>
        let deferredCharacterSampledLog: (() => void) | undefined
        const transactionResult = getDb().transaction(() => {
            const player = getPlayerSync(playerId)
            if (player === null) throw new Error("Gacha player disappeared during execution")
            const knownPlayerBefore = {
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            }

            let playerGachaData = getPlayerGachaInfoSync(playerId, gachaId)
            const insertPlayerGachaData = playerGachaData === null
            playerGachaData = playerGachaData ?? {
                gachaId: gachaId,
                isAccountFirst: true,
                isDailyFirst: true,
                gachaExchangePoint: 0,
            }
            let plannedCampaign: PlayerGachaCampaign | null = null
            const planResult = buildGachaExecPlan({
                gacha: gachaData,
                paymentType,
                execType: type,
                numberOfExec,
                playerFunds: {
                    freeVmoney: player.freeVmoney,
                    paidVmoney: player.vmoney,
                },
                playerGachaData,
                getTicketCount: (itemId) => getPlayerItemSync(playerId, itemId),
                getCampaignState: () => {
                    const campaignId = getGachaCampaignIdSync(gachaId)
                    if (campaignId === null) return null

                    const existingCampaign = getPlayerGachaCampaignSync(playerId, gachaId, campaignId)
                    const campaignForPlan: PlayerGachaCampaign = existingCampaign ?? {
                        gachaId,
                        campaignId,
                        count: 1,
                    }
                    plannedCampaign = campaignForPlan

                    return {
                        campaignId,
                        count: campaignForPlan.count,
                        insert: existingCampaign === null,
                    }
                },
            })
            if (!planResult.ok) return planResult

            const execPlan = planResult.plan
            const pullCount = execPlan.pullCount
            playerPaidVmoney = execPlan.paidVmoney
            playerFreeVmoney = execPlan.freeVmoney
            const drawMetadata = drawGachaWithMetadataSync(gachaData, pullCount)
            const drawResult = drawMetadata.map((draw) => draw.id)
            const characterMoviePlan = isCharacterGacha
                ? planCharacterGachaMovies(gachaData as CharacterGacha, drawResult)
                : undefined
            newGachaExchangePoint = (playerGachaData.gachaExchangePoint ?? 0) + pullCount

            if (execPlan.ticket) {
                items[execPlan.ticket.itemId] = execPlan.ticket.afterCount
                updatePlayerItemSync(playerId, execPlan.ticket.itemId, execPlan.ticket.afterCount)
            }

            if (execPlan.campaign) {
                const campaignData = plannedCampaign ?? {
                    gachaId,
                    campaignId: execPlan.campaign.campaignId,
                    count: execPlan.campaign.count,
                }
                campaignData.count = execPlan.campaign.count

                if (execPlan.campaign.insert) {
                    insertPlayerGachaCampaignSync(playerId, campaignData)
                } else {
                    updatePlayerGachaCampaignSync(playerId, gachaId, execPlan.campaign.campaignId, execPlan.campaign.count)
                }

                gachaCampaigns.push(serializeGachaCampaign(campaignData))
            }

            rewardResult = rewardPlayerGachaDrawResultSync(
                playerId,
                gachaData,
                drawResult,
                drawMetadata,
                characterMoviePlan,
                {
                    ownerGrant: plan => executeRewardGrantPlanInTransactionOwnerInternalSync(
                        playerId,
                        plan,
                        knownPlayerBefore,
                    ),
                    deferCharacterSampledLog: log => { deferredCharacterSampledLog = log },
                },
            )

            const historyType = isCharacterGacha ? MailType.CHARACTER : MailType.EQUIPMENT
            for (const itemId of drawResult) {
                insertReceiveHistorySync(playerId, { type: historyType, type_id: itemId, number: 1 })
            }

            if (insertPlayerGachaData) {
                playerGachaData.isAccountFirst = false
                playerGachaData.isDailyFirst = false
                playerGachaData.gachaExchangePoint = newGachaExchangePoint
                insertPlayerGachaInfoSync(playerId, playerGachaData)
            } else {
                updatePlayerGachaInfoSync(playerId, {
                    gachaId: gachaId,
                    isDailyFirst: false,
                    isAccountFirst: false,
                    gachaExchangePoint: newGachaExchangePoint
                })
            }

            updatePlayerSync({
                id: playerId,
                vmoney: playerPaidVmoney,
                freeVmoney: playerFreeVmoney
            })
            if (isCharacterGacha) {
                incrementActiveMissionGachaCharacterCountSync(playerId, drawResult.length)
            }
            if (execPlan.campaign) {
                incrementActiveMissionGachaCampaignCountSync(playerId)
            }
            return { ok: true as const }
        })()
        if (!transactionResult.ok) {
            console.log(`[GACHA] Exec plan rejected: gachaId=${gachaId} paymentType=${paymentType} type=${type} message=${transactionResult.message}`)
            return reply.status(transactionResult.status).send({
                "error": "Bad Request",
                "message": transactionResult.message,
            })
        }
        deferredCharacterSampledLog?.()

        reply.header("content-type", "application/x-msgpack")
        if (isCharacterGacha) {
            const existingCharacterList = rewardResult.characters.filter(
                (character): character is Record<string, unknown> =>
                    character !== undefined
                    && character !== null
                    && typeof character === "object"
                    && !Array.isArray(character)
            )
            const characterList = publishAwakeCharacterListBestEffort(
                playerId,
                [],
                [existingCharacterList],
                {},
            )

            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": {
                        "free_vmoney": playerFreeVmoney,
                        "vmoney": playerPaidVmoney
                    },
                    "draw": rewardResult.draw,
                    "character_list": characterList,
                    "item_list": {
                        ...items,
                        ...rewardResult.items
                    },
                    "gacha_campaign_list": gachaCampaigns,
                    "gacha_info_list": [
                        {
                            "gacha_id": gachaId,
                            "is_account_first": false,
                            "is_daily_first": false,
                            "gacha_exchange_point": newGachaExchangePoint
                        }
                    ],
                    "encyclopedia_info": [],
                    "mail_arrived": getMailArrivedSync(playerId)
                }
            })
        } else {
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": {
                        "free_vmoney": playerFreeVmoney,
                        "vmoney": playerPaidVmoney
                    },
                    "is_erupt": rewardResult.isErupt ?? false,
                    "draw_equipment": rewardResult.draw,
                    "item_list": {
                        ...items,
                        ...rewardResult.items
                    },
                    "equipment_list": rewardResult.equipment,
                    "gacha_info_list": [
                        {
                            "gacha_id": gachaId,
                            "is_account_first": false,
                            "is_daily_first": false,
                            "gacha_exchange_point": newGachaExchangePoint
                        }
                    ],
                    "encyclopedia_info": [],
                    "mail_arrived": getMailArrivedSync(playerId)
                }
            })
        }
        
    })
}

export default routes;
