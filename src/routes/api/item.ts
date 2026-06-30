// Handles item usage (stamina recovery items, etc.)
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, getPlayerSync, getSession, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";
import { generateDataHeaders, getServerTime } from "../../utils";
import { sellItemSync } from "../../lib/item-sell";
import { AccountId, PlayerId } from "../../lib/types";
import { computeRealTimeStamina } from "../../lib/stamina";
import itemData from "../../../assets/item_data.json";

interface ItemEffectInfo {
    effectKind: number
    effectValue: number
}

const ITEM_EFFECTS: Record<number, ItemEffectInfo> = itemData as Record<number, ItemEffectInfo>

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/use_item", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number
            api_count: number
            items: { id: number; number: number; selectIndex: number }[]
        }

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId) || !Array.isArray(body.items) || body.items.length === 0) {
            console.warn('[ITEM-USE] invalid request body')
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (!playerId) return reply.status(500).send({ "error": "Internal Server Error", "message": "No player bound to account." })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." })

        const config = getConfigSync()
        const maxOverflow = config.max_stamina_overflow

        let totalStaminaRecovery = 0
        const itemUpdates: { id: number; newCount: number }[] = []
        let hasStaminaItem = false

        for (const itemReq of body.items) {
            const itemId = itemReq.id
            const requestCount = itemReq.number

            if (!Number.isInteger(itemId) || itemId <= 0) {
                console.warn(`[ITEM-USE] invalid item id: ${itemId}`)
                continue
            }
            if (!Number.isInteger(requestCount) || requestCount <= 0) {
                console.warn(`[ITEM-USE] invalid count: ${requestCount} for item ${itemId}`)
                continue
            }

            const effectInfo = ITEM_EFFECTS[itemId]
            if (!effectInfo) {
                console.warn(`[ITEM-USE] item ${itemId} not in effect table, skipping`)
                continue
            }

            const { effectKind, effectValue } = effectInfo

            // Only handle stamina recovery items
            if (effectKind !== 2 && effectKind !== 3) {
                console.warn(`[ITEM-USE] item ${itemId} effectKind=${effectKind}, not a stamina item, skipping`)
                continue
            }

            // Verify ownership
            const currentCount = getPlayerItemSync(playerId, itemId) ?? 0
            if (currentCount < requestCount) {
                console.warn(`[ITEM-USE] player ${playerId} has ${currentCount} of item ${itemId}, requested ${requestCount}`)
                return reply.status(400).send({ "error": "Bad Request", "message": "Insufficient items." })
            }

            let recoveryAmount: number
            if (effectKind === 2) {
                // StaminaFixed: fixed recovery amount
                recoveryAmount = effectValue
            } else {
                // StaminaRate: percentage of max overflow
                const rate = Math.max(0, effectValue) / 100 // e.g. 50 = 50%
                recoveryAmount = Math.floor(Math.max(0, maxOverflow) * rate)
            }

            if (!isFinite(recoveryAmount) || recoveryAmount < 0) {
                console.warn(`[ITEM-USE] invalid recovery amount for item ${itemId}: ${recoveryAmount}`)
                recoveryAmount = 0
            }

            totalStaminaRecovery += recoveryAmount * requestCount
            itemUpdates.push({ id: itemId, newCount: currentCount - requestCount })
            hasStaminaItem = true
        }

        if (!hasStaminaItem) {
            console.warn(`[ITEM-USE] no valid stamina recovery items in request`)
            return reply.status(400).send({ "error": "Bad Request", "message": "No valid stamina items." })
        }

        if (totalStaminaRecovery <= 0) {
            console.warn(`[ITEM-USE] zero total recovery`)
            return reply.status(400).send({ "error": "Bad Request", "message": "Zero recovery." })
        }

        const currentStamina = computeRealTimeStamina(player)

        if (currentStamina >= maxOverflow) {
            console.log(`[ITEM-USE] player ${playerId} already at max stamina (${currentStamina} >= ${maxOverflow})`)
            return reply.status(400).send({ "error": "Bad Request", "code": 2102, "message": "Already at max stamina." })
        }

        const afterStamina = Math.min(currentStamina + totalStaminaRecovery, maxOverflow)

        // Batch update
        for (const upd of itemUpdates) {
            updatePlayerItemSync(playerId, upd.id, upd.newCount)
        }
        updatePlayerSync({
            id: playerId,
            stamina: afterStamina,
            staminaHealTime: new Date()
        })

        console.log(`[ITEM-USE] player ${playerId}: stamina ${currentStamina}->${afterStamina} (+${totalStaminaRecovery}), items: ${JSON.stringify(itemUpdates)}`)

        // Build item_list as IntMap<int> (client expects { itemId: count })
        const itemListMap: Record<number, number> = {}
        for (const upd of itemUpdates) {
            itemListMap[upd.id] = upd.newCount
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "stamina": afterStamina,
                    "stamina_heal_time": getServerTime()
                },
                "item_list": itemListMap
            }
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

        console.log(`[ITEM_SELL] account=${accountId} player=${playerId}: item ${itemId} ×${sellNumber} sold, mana +${result.manaGained} (${result.freeMana - result.manaGained} -> ${result.freeMana})`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "item_list": { [itemId]: result.newCount },
                "user_info": { "free_mana": result.freeMana },
                "mail_arrived": false
            }
        })
    })
}

export default routes
