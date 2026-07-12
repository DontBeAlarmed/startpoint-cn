// Handles item usage (stamina recovery items, select bonus boxes, etc.)
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, updatePlayerItemSync, setPlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { sellItemSync } from "../../lib/item-sell";
import { AccountId, PlayerId } from "../../lib/types";
import { computeRealTimeStamina } from "../../lib/stamina";
import itemData from "../../../assets/item_data.json";
import itemBonusSelectData from "../../../assets/item_bonus_select.json";

interface ItemEffectInfo {
    effectKind: number
    effectValue: number
}

interface ItemBonusSelectInfo {
    name: string
    bonuses: ({ itemId: number, amount: number } | null)[]
}

const ITEM_EFFECTS: Record<number, ItemEffectInfo> = itemData as Record<number, ItemEffectInfo>
// effect 22 (CultivatePack) select boxes: box item id -> 6 selectable bonuses (master item_bonus_select mirror)
const BONUS_BOXES: Record<number, ItemBonusSelectInfo> = itemBonusSelectData as Record<number, ItemBonusSelectInfo>

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
        // reward item id -> amount gained from select bonus boxes this request
        const bonusRewards: Record<number, number> = {}
        let hasStaminaItem = false
        let hasBonusBox = false

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

            // effect 22 select bonus box: consume box, grant the chosen bonus (selectIndex is 1-based)
            const boxDef = BONUS_BOXES[itemId]
            if (boxDef) {
                const selectIndex = itemReq.selectIndex
                if (!Number.isInteger(selectIndex) || selectIndex < 1 || selectIndex > boxDef.bonuses.length) {
                    console.warn(`[ITEM-USE] invalid selectIndex ${selectIndex} for box ${itemId}`)
                    return reply.status(400).send({ "error": "Bad Request", "message": "Invalid select index." })
                }
                const bonus = boxDef.bonuses[selectIndex - 1]
                if (!bonus) {
                    console.warn(`[ITEM-USE] empty bonus slot ${selectIndex} for box ${itemId}`)
                    return reply.status(400).send({ "error": "Bad Request", "message": "Empty bonus slot." })
                }

                const boxCount = getPlayerItemSync(playerId, itemId) ?? 0
                if (boxCount < requestCount) {
                    console.warn(`[ITEM-USE] player ${playerId} has ${boxCount} of box ${itemId}, requested ${requestCount}`)
                    return reply.status(400).send({ "error": "Bad Request", "message": "Insufficient items." })
                }

                itemUpdates.push({ id: itemId, newCount: boxCount - requestCount })
                bonusRewards[bonus.itemId] = (bonusRewards[bonus.itemId] ?? 0) + bonus.amount * requestCount
                hasBonusBox = true
                console.log(`[ITEM-USE] player ${playerId}: box ${itemId}(${boxDef.name}) ×${requestCount} -> item ${bonus.itemId} ×${bonus.amount * requestCount} (select ${selectIndex})`)
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

        if (!hasStaminaItem && !hasBonusBox) {
            console.warn(`[ITEM-USE] no valid usable items in request`)
            return reply.status(400).send({ "error": "Bad Request", "message": "No valid usable items." })
        }

        let afterStamina: number | null = null
        if (hasStaminaItem) {
            if (totalStaminaRecovery <= 0) {
                console.warn(`[ITEM-USE] zero total recovery`)
                return reply.status(400).send({ "error": "Bad Request", "message": "Zero recovery." })
            }

            const currentStamina = computeRealTimeStamina(player)

            if (currentStamina >= maxOverflow) {
                console.log(`[ITEM-USE] player ${playerId} already at max stamina (${currentStamina} >= ${maxOverflow})`)
                return reply.status(400).send({ "error": "Bad Request", "code": 2102, "message": "Already at max stamina." })
            }

            afterStamina = Math.min(currentStamina + totalStaminaRecovery, maxOverflow)
            console.log(`[ITEM-USE] player ${playerId}: stamina ${currentStamina}->${afterStamina} (+${totalStaminaRecovery})`)
        }

        // Batch update: consumed items (stamina items + boxes), then box rewards
        for (const upd of itemUpdates) {
            updatePlayerItemSync(playerId, upd.id, upd.newCount)
        }

        // Build item_list as IntMap<int> (client expects { itemId: count })
        const itemListMap: Record<number, number> = {}
        for (const upd of itemUpdates) {
            itemListMap[upd.id] = upd.newCount
        }
        for (const [rewardIdStr, gained] of Object.entries(bonusRewards)) {
            const rewardId = Number(rewardIdStr)
            const newCount = (getPlayerItemSync(playerId, rewardId) ?? 0) + gained
            setPlayerItemSync(playerId, rewardId, newCount)
            itemListMap[rewardId] = newCount
        }

        if (afterStamina !== null) {
            updatePlayerSync({
                id: playerId,
                stamina: afterStamina,
                staminaHealTime: new Date()
            })
        }

        console.log(`[ITEM-USE] player ${playerId}: items: ${JSON.stringify(itemListMap)}`)

        const userInfo: Record<string, unknown> = afterStamina !== null
            ? { "stamina": afterStamina, "stamina_heal_time": realToVirtual(new Date()) }
            : {}

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": userInfo,
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
