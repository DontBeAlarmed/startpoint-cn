import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils"
import { getGameTimeContext } from "../../runtime/time/game-time"
import { getMailArrivedSync } from "../../lib/mail-notification"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication"
import {
    buySpecialExchangeTicketSync,
    enterSpecialExchangeCampaignSync,
    exchangeSpecialExchangeTargetSync,
    projectSpecialExchangeBuyTicketResponse,
    projectSpecialExchangeEnterResponse,
    projectSpecialExchangeTargetResponse,
} from "../../lib/special-exchange"

interface CampaignBody {
    viewer_id: number
    campaign_id: number
    api_count?: number
}

interface ExchangeBody extends CampaignBody {
    character_id?: number
    equipment_id?: number
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

const routes = async (fastify: FastifyInstance): Promise<void> => {
    fastify.post("/enter_campaign", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CampaignBody
        const viewerId = body.viewer_id
        const campaignId = body.campaign_id
        if (!positiveInteger(viewerId) || !positiveInteger(campaignId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                error: "Internal Server Error",
                message: "No players bound to account.",
            })
        }

        const result = enterSpecialExchangeCampaignSync({
            playerId,
            campaignId,
            nowMs: getGameTimeContext().virtualNowMs,
        })
        if (!result.ok) {
            if (result.kind === "outOfPeriod") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: result.resultCode,
                    }),
                    data: {},
                })
            }
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            ...projectSpecialExchangeEnterResponse(result),
        })
    })

    fastify.post("/buy_ticket", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CampaignBody
        const viewerId = body.viewer_id
        const campaignId = body.campaign_id
        if (!positiveInteger(viewerId) || !positiveInteger(campaignId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                error: "Internal Server Error",
                message: "No players bound to account.",
            })
        }

        const result = buySpecialExchangeTicketSync({
            playerId,
            campaignId,
            nowMs: getGameTimeContext().virtualNowMs,
        })
        if (!result.ok) {
            if (result.kind === "outOfPeriod") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: result.resultCode,
                    }),
                    data: {},
                })
            }
            if (result.kind === "insufficientPaidVmoney") {
                // 防御路径先例（src/routes/api/shop.ts recover_stamina）：带内
                // result_code 0 + console.warn，余额与券不动。
                console.warn(
                    `[SPECIAL-EXCHANGE] buy_ticket rejected player=${playerId}`
                    + ` campaign=${campaignId}: ${result.message}`,
                )
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: 0,
                    }),
                    data: {},
                })
            }
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectSpecialExchangeBuyTicketResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            mailArrived: getMailArrivedSync(playerId),
        }))
    })

    fastify.post("/exchange_character", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeBody
        const viewerId = body.viewer_id
        const campaignId = body.campaign_id
        const targetId = body.character_id
        if (!positiveInteger(viewerId) || !positiveInteger(campaignId) || !positiveInteger(targetId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                error: "Internal Server Error",
                message: "No players bound to account.",
            })
        }

        const result = exchangeSpecialExchangeTargetSync({
            playerId,
            campaignId,
            targetId,
            nowMs: getGameTimeContext().virtualNowMs,
        })
        if (!result.ok) {
            if (result.kind === "outOfPeriod") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: result.resultCode,
                    }),
                    data: {},
                })
            }
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            })
        }

        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            result.campaign.type === 0 ? [targetId] : [],
            result.characters.length > 0 ? [result.characters] : [],
            {},
            "special_exchange/exchange_character",
        ).characterList

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectSpecialExchangeTargetResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            characterList,
            mailArrived: getMailArrivedSync(playerId),
        }))
    })

    fastify.post("/exchange_equipment", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeBody
        const viewerId = body.viewer_id
        const campaignId = body.campaign_id
        const targetId = body.equipment_id
        if (!positiveInteger(viewerId) || !positiveInteger(campaignId) || !positiveInteger(targetId)) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const session = await getSession(String(viewerId))
        if (session === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        }
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                error: "Internal Server Error",
                message: "No players bound to account.",
            })
        }

        const result = exchangeSpecialExchangeTargetSync({
            playerId,
            campaignId,
            targetId,
            nowMs: getGameTimeContext().virtualNowMs,
        })
        if (!result.ok) {
            if (result.kind === "outOfPeriod") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: result.resultCode,
                    }),
                    data: {},
                })
            }
            return reply.status(result.kind === "badRequest" ? 400 : 500).send({
                error: result.kind === "badRequest" ? "Bad Request" : "Internal Server Error",
                message: result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectSpecialExchangeTargetResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            characterList: [],
            mailArrived: getMailArrivedSync(playerId),
        }))
    })
}

export default routes
