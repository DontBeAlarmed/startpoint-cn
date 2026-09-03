import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { resolvePlayerIdSync } from "../../../data/activeAccount"
import { getSession } from "../../../data/domains/session"
import { publishCharacterGrowthOwnerStateBestEffort } from "../../../lib/character-growth/owner-publication"
import { getMailArrivedSync } from "../../../lib/mail-notification"
import {
    ShopOfferNotPurchasableError,
    ShopOfferPeriodError,
} from "../../../lib/shop"
import { executeShopPurchaseSync } from "../../../lib/shop/owner"
import {
    InvalidShopPurchaseCommandError,
    ShopPurchaseBalancePlanError,
    ShopPurchaseLimitPlanError,
    ShopPurchasePlanError,
} from "../../../lib/shop/purchase-plan"
import { projectShopPurchaseResponse } from "../../../lib/shop/response-projector"
import { ShopType } from "../../../lib/types"
import { getGameTimeContext } from "../../../runtime/time/game-time"
import { generateDataHeaders } from "../../../utils"

interface BuyBody {
    readonly viewer_id?: unknown
    readonly shop_type?: unknown
    readonly shop_item_id?: unknown
    readonly number?: unknown
}

interface BulkBuyBody {
    readonly viewer_id?: unknown
    readonly shop_type?: unknown
    readonly buy_item_list?: unknown
}

const SINGLE_SHOP_TYPES = new Set<number>([
    ShopType.TREASURE,
    ShopType.SPECIAL_PACK,
    ShopType.EVENT_ITEM,
    ShopType.MANA,
    ShopType.BOSS_COIN,
    ShopType.GENERAL,
    ShopType.STAR_GRAIN,
    ShopType.TREASURE_EQUIPMENT,
])

function positiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isBody(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function badRequest(reply: FastifyReply, message: string) {
    return reply.status(400).send({ error: "Bad Request", message })
}

async function resolvePurchasePlayerId(
    viewerId: number,
    reply: FastifyReply,
): Promise<number | null> {
    const session = await getSession(String(viewerId))
    if (session === null) {
        badRequest(reply, "Invalid viewer id.")
        return null
    }
    const playerId = resolvePlayerIdSync(session.accountId)
    if (playerId === null) {
        reply.status(500).send({
            error: "Internal Server Error",
            message: "No players bound to account.",
        })
        return null
    }
    return playerId
}

function sendPurchaseError(
    error: unknown,
    viewerId: number,
    reply: FastifyReply,
) {
    if (error instanceof ShopOfferPeriodError) {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: viewerId,
                result_code: error.resultCode,
            }),
            data: {},
        })
    }
    if (error instanceof ShopOfferNotPurchasableError
        || error instanceof InvalidShopPurchaseCommandError
        || error instanceof ShopPurchaseBalancePlanError
        || error instanceof ShopPurchaseLimitPlanError
        || error instanceof ShopPurchasePlanError) {
        return badRequest(reply, error.message || "Shop purchase is invalid.")
    }
    throw error
}

export function registerShopPurchaseRoutes(
    fastify: FastifyInstance,
    dailyResetHour: number,
): void {
    fastify.post("/buy", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isBody(request.body)) return badRequest(reply, "Invalid request body.")
        const body = request.body as BuyBody
        if (!positiveSafeInteger(body.viewer_id)
            || !positiveSafeInteger(body.shop_item_id)
            || !positiveSafeInteger(body.number)
            || typeof body.shop_type !== "number"
            || !SINGLE_SHOP_TYPES.has(body.shop_type)) {
            return badRequest(reply, "Invalid request body.")
        }
        const playerId = await resolvePurchasePlayerId(body.viewer_id, reply)
        if (playerId === null) return
        const gameTime = getGameTimeContext()
        try {
            const result = executeShopPurchaseSync({
                playerId,
                shopType: body.shop_type,
                entries: [{ shopItemId: body.shop_item_id, purchaseAmount: body.number }],
                virtualNowMs: gameTime.virtualNowMs,
                purchasePeriodNowMs: gameTime.realNowMs,
                resetHour: dailyResetHour,
            })
            const responseData = projectShopPurchaseResponse(result, body.viewer_id)
            responseData.character_list = publishCharacterGrowthOwnerStateBestEffort(
                result.playerId,
                result.joinedCharacterIds,
                [responseData.character_list],
                { invalidatedFactKeys: result.rewardInvalidatedFactKeys },
                "shop/buy",
                gameTime.virtualNow,
            ).characterList
            responseData.mail_arrived = getMailArrivedSync(result.playerId)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
                data: responseData,
            })
        } catch (error) {
            return sendPurchaseError(error, body.viewer_id, reply)
        }
    })

    fastify.post("/bulk_buy", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isBody(request.body)) return badRequest(reply, "Invalid request body.")
        const body = request.body as BulkBuyBody
        if (!positiveSafeInteger(body.viewer_id)
            || (body.shop_type !== ShopType.EVENT_ITEM && body.shop_type !== ShopType.BOSS_COIN)
            || typeof body.buy_item_list !== "object"
            || body.buy_item_list === null
            || Array.isArray(body.buy_item_list)) {
            return badRequest(reply, "Invalid request body.")
        }
        const rawEntries = Object.entries(body.buy_item_list as Record<string, unknown>)
        if (rawEntries.length === 0) {
            return badRequest(reply, "Bulk purchase must contain at least one item.")
        }
        const entries = []
        for (const [itemIdText, amount] of rawEntries) {
            if (!/^[1-9]\d*$/.test(itemIdText) || !positiveSafeInteger(amount)) {
                return badRequest(reply, "Invalid bulk purchase item.")
            }
            const shopItemId = Number(itemIdText)
            if (!positiveSafeInteger(shopItemId)) {
                return badRequest(reply, "Invalid bulk purchase item.")
            }
            entries.push({ shopItemId, purchaseAmount: amount })
        }
        const playerId = await resolvePurchasePlayerId(body.viewer_id, reply)
        if (playerId === null) return
        const gameTime = getGameTimeContext()
        try {
            const result = executeShopPurchaseSync({
                playerId,
                shopType: body.shop_type,
                entries,
                virtualNowMs: gameTime.virtualNowMs,
                purchasePeriodNowMs: gameTime.realNowMs,
                resetHour: dailyResetHour,
            })
            const responseData = projectShopPurchaseResponse(result, body.viewer_id)
            responseData.character_list = publishCharacterGrowthOwnerStateBestEffort(
                result.playerId,
                result.joinedCharacterIds,
                [responseData.character_list],
                { invalidatedFactKeys: result.rewardInvalidatedFactKeys },
                "shop/bulk-buy",
                gameTime.virtualNow,
            ).characterList
            responseData.mail_arrived = getMailArrivedSync(result.playerId)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                data_headers: generateDataHeaders({ viewer_id: body.viewer_id }),
                data: responseData,
            })
        } catch (error) {
            return sendPurchaseError(error, body.viewer_id, reply)
        }
    })
}
