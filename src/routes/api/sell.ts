// Equipment dismantle/sell endpoints: sell_equipment, sell_stack, bulk_sell_stack.
// Registered under /api/index.php/equipment prefix (shared with equipment.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    deletePlayerEquipmentSync, getPlayerEquipmentSync, updatePlayerEquipmentSync,
} from "../../data/domains/equipment";
import { givePlayerItemSync } from "../../data/domains/item";
import { getSession } from "../../data/domains/session";
import { generateDataHeaders } from "../../utils";
import { clientSerializeEquipment, buildFullEquipmentList } from "../../lib/equipment";
import { calculateDissolveRewards } from "../../lib/equipment-dissolve";
import { asAccountId, asPlayerId, AccountId, PlayerId } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";

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
        const seen = new Set<number>()

        for (const toSell of toSellEquipmentList) {
            const equipmentId = toSell.equipment_id
            if (seen.has(equipmentId)) continue
            seen.add(equipmentId)
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })
            }
            if (equipment.protection) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Protected equipment cannot be sold." })
            }

            // `stack` is the duplicate count; the base equipment is always one
            // additional unit and is also sold by this endpoint.
            const sellCount = equipment.stack + 1

            const rewards = calculateDissolveRewards(equipmentId, sellCount)
            totalCraftPoints += rewards.craftPoints
            totalStarGrains += rewards.starGrains
            for (const [soulId, count] of Object.entries(rewards.abilitySouls)) {
                totalAbilitySouls[parseInt(soulId)] = (totalAbilitySouls[parseInt(soulId)] ?? 0) + count
            }

            soldIds.push(equipmentId)
        }

            const returnItemList: Record<number, number> = {}
        getDb().transaction(() => {
            for (const equipmentId of soldIds) {
                deletePlayerEquipmentSync(playerId, equipmentId)
            }
            if (totalCraftPoints > 0) {
                returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
            }
            if (totalStarGrains > 0) {
                returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
            }
            for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
                returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
            }
        })()

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
                "mail_arrived": getMailArrivedSync(playerId)
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
        const requestedCounts = new Map<number, number>()
        for (const toSell of toSellEquipmentList) {
            const sellCount = (toSell as SellStackEquipmentListItem).number
            if (!Number.isInteger(sellCount) || sellCount <= 0) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Invalid sell count." })
            }
            requestedCounts.set(
                toSell.equipment_id,
                (requestedCounts.get(toSell.equipment_id) ?? 0) + sellCount,
            )
        }
        const stackUpdates: Array<{ equipmentId: number, newStack: number }> = []

        for (const [equipmentId, sellCount] of requestedCounts) {
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })
            }
            if (equipment.protection) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Protected equipment cannot be sold." })
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

            stackUpdates.push({ equipmentId, newStack })
        }

        const returnItemList: Record<number, number> = {}
        getDb().transaction(() => {
            for (const update of stackUpdates) {
                updatePlayerEquipmentSync(playerId, update.equipmentId, { stack: update.newStack })
            }
            if (totalCraftPoints > 0) {
                returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
            }
            if (totalStarGrains > 0) {
                returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
            }
            for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
                returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
            }
        })()

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
                "mail_arrived": getMailArrivedSync(playerId)
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
            if (equipment.protection) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Protected equipment cannot be sold." })
            }

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
                "data": { "equipment_list": [], "item_list": {}, "mail_arrived": getMailArrivedSync(playerId) }
            })
        }

        const returnItemList: Record<number, number> = {}
        getDb().transaction(() => {
            for (const equipmentId of toSell) {
                updatePlayerEquipmentSync(playerId, equipmentId, { stack: 0 })
            }
            if (totalCraftPoints > 0) {
                returnItemList[wrightpieceItemId()] = givePlayerItemSync(playerId, wrightpieceItemId(), totalCraftPoints)
            }
            if (totalStarGrains > 0) {
                returnItemList[starGrainItemId()] = givePlayerItemSync(playerId, starGrainItemId(), totalStarGrains)
            }
            for (const [soulId, count] of Object.entries(totalAbilitySouls)) {
                returnItemList[parseInt(soulId)] = givePlayerItemSync(playerId, parseInt(soulId), count)
            }
        })()

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
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })
}

export default routes;
