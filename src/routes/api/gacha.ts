import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, insertReceiveHistorySync } from "../../data/domains/mail"
import { getPlayerGachaInfoSync, updatePlayerGachaInfoSync } from "../../data/domains/gacha"
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { getGachaSync } from "../../lib/assets";
import { GachaType } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { getExchangeableGachaItem } from "../../lib/gacha-rules";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow";
import {
    executeGachaDrawSync,
    projectGachaExecResponse,
    runGachaPostCommitEffects,
} from "../../lib/gacha-owner";
import { getVirtualNow } from "../../runtime/time/game-time";

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

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
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
        const characterList = publishCharacterGrowthOwnerStateBestEffort(
            playerId,
            [characterId],
            [existingCharacterList],
            {},
            "gacha/character-grant",
        ).characterList
        const overMax = projectItemOverflowCommonResponse(
            giveResult.itemOverflowDispositions ?? [],
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": characterList,
                "item_list": giveResult.item !== undefined ? {
                    [giveResult.item.id]: giveResult.itemAfterAmount ?? giveResult.item.count
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
                "mail_arrived": getMailArrivedSync(playerId),
                ...(overMax.length > 0 ? { "over_max": overMax } : {}),
                ...(giveResult.overflowFreeManaAfter === undefined
                    ? {}
                    : { "user_info": { "free_mana": giveResult.overflowFreeManaAfter } }),
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
        if (!isPositiveSafeInteger(viewerId)
            || !isPositiveSafeInteger(gachaId)
            || !isPositiveSafeInteger(paymentType)
            || !isPositiveSafeInteger(numberOfExec)
            || !isPositiveSafeInteger(type)) {
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

        const result = executeGachaDrawSync({
            playerId,
            gachaId,
            paymentType,
            execType: type,
            numberOfExec,
            nowMs: getVirtualNow().getTime(),
        })
        if (!result.ok) {
            console.log(`[GACHA] Exec rejected: gachaId=${gachaId} paymentType=${paymentType} type=${type} message=${result.message}`)
            if (result.kind === "protocolResultCode") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    data_headers: generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: result.resultCode,
                    }),
                    data: {},
                })
            }
            return reply.status(400).send({
                "error": "Bad Request",
                "message": result.message,
            })
        }
        const postCommit = runGachaPostCommitEffects(result)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send(projectGachaExecResponse({
            dataHeaders: generateDataHeaders({ viewer_id: viewerId }),
            result,
            postCommit,
        }))
        
    })
}

export default routes;
