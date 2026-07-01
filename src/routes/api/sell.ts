// Equipment dismantle/sell endpoints: sell_equipment, sell_stack, bulk_sell_stack.
// Registered under /api/index.php/equipment prefix (shared with equipment.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerEquipmentSync, getSession, givePlayerItemSync,
    updatePlayerEquipmentSync
} from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { clientSerializeEquipment, buildFullEquipmentList } from "../../lib/equipment";
import { calculateDissolveRewards } from "../../lib/equipment-dissolve";
import { asAccountId, asPlayerId, AccountId, PlayerId } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";

interface SellEquipmentListItem {
    equipment_id: number
}

interface SellStackEquipmentListItem extends SellEquipmentListItem {
    number: number
}

interface SellBody {
    equipment_list: SellEquipmentListItem[],
    viewer_id: number,
    api_count: number
}

interface BulkSellStackBody {
    viewer_id: number
    api_count: number
    equipment_ids: number[]
}

const wrightpieceItemId = () => getConfigSync().craft_point_item_id || 100000
const starGrainItemId = () => getConfigSync().star_grain_item_id || 990008

const routes = async (fastify: FastifyInstance) => {

    // ── sell_equipment (single equipment, all stacks) ──────────────────
    fastify.post("/sell_equipment", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellBody

        const viewerId = body.viewer_id
        const toSellEquipmentList = body.equipment_list
        if (isNaN(viewerId) || !toSellEquipmentList) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        let totalCraftPoints = 0
        let totalStarGrains = 0
        const totalAbilitySouls: Record<number, number> = {}
        const soldIds: number[] = []

        for (const toSell of toSellEquipmentList) {
            const equipmentId = toSell.equipment_id
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })
            }

            const stack = equipment.stack
            if (stack <= 0) continue

            // 1 unit, not × stack (client Expected sell_equipment gives 1 ability soul per unit)
            const rewards = calculateDissolveRewards(equipmentId, 1)
            totalCraftPoints += rewards.craftPoints
            totalStarGrains += rewards.starGrains
            for (const [soulId, count] of Object.entries(rewards.abilitySouls)) {
                totalAbilitySouls[parseInt(soulId)] = (totalAbilitySouls[parseInt(soulId)] ?? 0) + count
            }

            updatePlayerEquipmentSync(playerId, equipmentId, { stack: 0 })
            soldIds.push(equipmentId)
        }

        const returnItemList: Record<number, number> = {}
        if (totalCraftPoints > 0) {
            returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
        }
        if (totalStarGrains > 0) {
            returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
        }
        for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
            returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
        }

        const returnEquipmentList = buildFullEquipmentList(playerId)

        const craftLog = totalCraftPoints > 0 ? `craft +${totalCraftPoints} ` : ""
        const starLog = totalStarGrains > 0 ? `star +${totalStarGrains} ` : ""
        const soulTypes = Object.keys(totalAbilitySouls).length
        const soulDetail = Object.entries(totalAbilitySouls).map(([id, c]) => `${id}×${c}`).join(' ')
        console.log(`[SELL_EQUIP] account=${accountId} player=${playerId}: ${soldIds.length} equipment sold (${soldIds.join(',')}), ${craftLog}${starLog}ability souls: ${soulTypes} types [${soulDetail}]`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    })

    // ── sell_stack (partial stack sale) ─────────────────────────────────
    fastify.post("/sell_stack", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellBody

        const viewerId = body.viewer_id
        const toSellEquipmentList = body.equipment_list
        if (isNaN(viewerId) || !toSellEquipmentList) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        let totalCraftPoints = 0
        let totalStarGrains = 0
        const totalAbilitySouls: Record<number, number> = {}

        for (const toSell of toSellEquipmentList) {
            const equipmentId = toSell.equipment_id
            const sellCount = Math.max(1, (toSell as SellStackEquipmentListItem).number)
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })
            }

            const newStack = equipment.stack - sellCount
            if (newStack < 0) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Attempt to sell more stacks than owned." })
            }

            const rewards = calculateDissolveRewards(equipmentId, sellCount)
            totalCraftPoints += rewards.craftPoints
            totalStarGrains += rewards.starGrains
            for (const [soulId, count] of Object.entries(rewards.abilitySouls)) {
                totalAbilitySouls[parseInt(soulId)] = (totalAbilitySouls[parseInt(soulId)] ?? 0) + count
            }

            equipment.stack = newStack
            updatePlayerEquipmentSync(playerId, equipmentId, { stack: newStack })
        }

        const returnItemList: Record<number, number> = {}
        if (totalCraftPoints > 0) {
            returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
        }
        if (totalStarGrains > 0) {
            returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
        }
        for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
            returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
        }

        const returnEquipmentList = buildFullEquipmentList(playerId)

        const soulTypes = Object.keys(totalAbilitySouls).length
        const soulDetail = Object.entries(totalAbilitySouls).map(([id, c]) => `${id}×${c}`).join(' ')
        console.log(`[SELL_STACK] account=${accountId} player=${playerId}: ${toSellEquipmentList.length} equipment stack sold, craft +${totalCraftPoints} star +${totalStarGrains} ability souls: ${soulTypes} types [${soulDetail}]`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    })

    // ── bulk_sell_stack (one-click dismantle) ──────────────────────────
    fastify.post("/bulk_sell_stack", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkSellStackBody

        const viewerId = body.viewer_id
        const equipmentIds = body.equipment_ids
        if (isNaN(viewerId) || !equipmentIds || !Array.isArray(equipmentIds) || equipmentIds.length === 0) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        // Phase 1: calculate rewards per equipment
        let totalCraftPoints = 0
        let totalStarGrains = 0
        const totalAbilitySouls: Record<number, number> = {}
        const toSell: number[] = []
        const seen = new Set<number>()

        for (const equipmentId of equipmentIds) {
            if (seen.has(equipmentId)) continue
            seen.add(equipmentId)

            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) continue

            const stack = equipment.stack
            if (stack <= 0) continue

            const rewards = calculateDissolveRewards(equipmentId, stack)
            totalCraftPoints += rewards.craftPoints
            totalStarGrains += rewards.starGrains
            for (const [soulId, count] of Object.entries(rewards.abilitySouls)) {
                totalAbilitySouls[parseInt(soulId)] = (totalAbilitySouls[parseInt(soulId)] ?? 0) + count
            }
            console.log(`[BULK_SELL] account=${accountId} player=${playerId}  -> eid=${equipmentId} stack=${stack} rarity=${Math.floor(equipmentId/1000000)} craft=${rewards.craftPoints} star=${rewards.starGrains} souls=${JSON.stringify(rewards.abilitySouls)}`)
            toSell.push(equipmentId)
        }

        if (toSell.length === 0) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": { "equipment_list": [], "item_list": {}, "mail_arrived": false }
            })
        }

        // Phase 2: set stack to 0 (persist equipment row), give items
        for (const equipmentId of toSell) {
            updatePlayerEquipmentSync(playerId, equipmentId, { stack: 0 })
        }

        const returnItemList: Record<number, number> = {}
        if (totalCraftPoints > 0) {
            returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
        }
        if (totalStarGrains > 0) {
            returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
        }
        for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
            returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
        }

        const returnEquipmentList = buildFullEquipmentList(playerId)

        const craftLog = totalCraftPoints > 0 ? `craft +${totalCraftPoints} ` : ""
        const starLog = totalStarGrains > 0 ? `star +${totalStarGrains} ` : ""
        const soulTypes = Object.keys(totalAbilitySouls).length
        const soulDetail = Object.entries(totalAbilitySouls).map(([id, c]) => `${id}×${c}`).join(' ')
        console.log(`[BULK_SELL] account=${accountId} player=${playerId}: ${toSell.length} equipment dissolved (${toSell.join(',')}), ${craftLog}${starLog}ability souls: ${soulTypes} types [${soulDetail}]`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    })
}

export default routes;
