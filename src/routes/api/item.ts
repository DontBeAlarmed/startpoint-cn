// Handles item usage (stamina recovery items, etc.)
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { sellItemSync } from "../../lib/item-sell";
import { AccountId, PlayerId } from "../../lib/types";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";
import {
    ItemUsePlayerNotFoundError,
    ItemUseValidationError,
    settleItemUseInCallerTransactionSync,
} from "../../lib/item-use-settlement";

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/use_item", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown> | null

        const viewerId = body?.viewer_id
        if (typeof viewerId !== "number" || !Number.isSafeInteger(viewerId) || viewerId <= 0) {
            console.warn('[ITEM-USE] invalid request body')
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (!playerId) return reply.status(500).send({ "error": "Internal Server Error", "message": "No player bound to account." })

        let settlement
        try {
            settlement = getDb().transaction(() => (
                settleItemUseInCallerTransactionSync(
                    playerId,
                    body,
                    getConfigSync().max_stamina_overflow,
                )
            ))()
        } catch (error) {
            if (error instanceof ItemUseValidationError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    ...(error.resultCode === undefined ? {} : { code: error.resultCode }),
                    "message": error.message,
                })
            }
            if (error instanceof ItemUsePlayerNotFoundError) {
                return reply.status(500).send({ "error": "Internal Server Error", "message": error.message })
            }
            console.error(`[ITEM-USE] settlement failed for player ${playerId}`, error)
            throw error
        }

        const { plan, itemList: itemListMap } = settlement
        const recoveryTime = plan.stamina?.recoveryTime ?? new Date()

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, unknown> = {
            "item_list": itemListMap,
            "mail_arrived": getMailArrivedSync(playerId),
        }
        if (plan.stamina !== null) {
            responseData.user_info = {
                "stamina": plan.stamina.after,
                "stamina_heal_time": realToVirtual(recoveryTime)
            }
        }
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData,
        })
    })

    // ── sell (sell items/ability souls for mana) ────────────────────────
    fastify.post("/sell", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number
            api_count: number
            item_id: number
            sell_number: number
        }

        const viewerId = body.viewer_id
        const itemId = body.item_id
        const sellNumber = body.sell_number
        if (!viewerId || isNaN(viewerId) || !itemId || isNaN(itemId) || !sellNumber || isNaN(sellNumber)) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (!playerId) return reply.status(500).send({ "error": "Internal Server Error", "message": "No player bound to account." })

        const result = sellItemSync(playerId, itemId, sellNumber)
        if (!result.ok) {
            const code = 'errorCode' in result ? result.errorCode : undefined
            return reply.status(400).send({ "error": "Bad Request", "code": code, "message": result.error })
        }
        const characterList = reconcileAwakeUnlockCharacterList(playerId, [])

        console.log(`[ITEM_SELL] account=${accountId} player=${playerId}: item ${itemId} ×${sellNumber} sold, mana +${result.manaGained} (${result.freeMana - result.manaGained} -> ${result.freeMana})`)

        const responseData: Record<string, unknown> = {
            "item_list": { [itemId]: result.newCount },
            "user_info": { "free_mana": result.freeMana },
            "mail_arrived": getMailArrivedSync(playerId)
        }
        if (characterList.length > 0) responseData.character_list = characterList

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData
        })
    })
}

export default routes
