// Equipment awakening and protection endpoints: upgrade, bulk_upgrade, set_protection.
// Dismantle/sell endpoints are in sell.ts (same /equipment prefix).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerEquipmentSync, getPlayerItemSync, getPlayerSync, getSession,
    givePlayerItemSync, playerOwnsEquipmentSync, updatePlayerEquipmentSync,
    updatePlayerItemSync
} from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { clientSerializeEquipment } from "../../lib/equipment";
import { getEquipmentDissolveSync } from "../../lib/assets";
import { AccountId, PlayerId } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";

interface SetProtectionBody {
    protection: boolean
    equipment_ids: number[]
    viewer_id: number
    api_count: number
}

interface UpgradeBody {
    use_stack: boolean,
    upgrade_count: number,
    item_id?: number,
    viewer_id: number,
    api_count: number,
    equipment_id: number
}

interface BulkUpgradeBody {
    viewer_id: number
    api_count: number
    equipment_ids: number[]
}

const wrightpieceItemId = 100000

// wrightpiece cost for each rank of weapon (awakening)
const equipmentUpgradeCost = [5, 10, 15, 20, 25]

const routes = async (fastify: FastifyInstance) => {

    // ── upgrade (single equipment awakening) ───────────────────────────
    fastify.post("/upgrade", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpgradeBody

        const viewerId = body.viewer_id
        const upgradeCount = Math.max(1, body.upgrade_count ?? 1)
        const useStack = body.use_stack
        const itemId = body.item_id
        const equipmentId = body.equipment_id
        if (isNaN(viewerId) || isNaN(equipmentId) || useStack === undefined) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        const equipment = getPlayerEquipmentSync(playerId, equipmentId)
        if (!equipment) return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })

        const newLevel = equipment.level + upgradeCount
        if (newLevel > 5) return reply.status(400).send({ "error": "Bad Request", "message": "Cannot upgrade weapon more than 4 times." })

        const newStack = useStack ? equipment.stack - upgradeCount : equipment.stack
        if (newStack < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough stack." })

        const equipmentRarity = Math.floor(equipmentId / 1000000) - 1
        const wrightPieces = getPlayerItemSync(playerId, wrightpieceItemId) ?? 0
        const upgradeCost = equipmentUpgradeCost[equipmentRarity] ?? 0
        const newWrightPieces = wrightPieces - (upgradeCost * upgradeCount)
        if (newWrightPieces < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough of wrightpieces." })

        const itemCount = itemId ? getPlayerItemSync(playerId, itemId) ?? 0 : 0
        const newItemCount = !useStack ? itemCount - upgradeCount : itemCount
        if (newItemCount < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough of item." })

        const returnItemList: Record<string, number> = {}

        if (!useStack && itemId !== undefined) {
            returnItemList[itemId] = newItemCount
            updatePlayerItemSync(playerId, itemId, newItemCount)
        }

        returnItemList[wrightpieceItemId] = newWrightPieces
        updatePlayerItemSync(playerId, wrightpieceItemId, newWrightPieces)

        equipment.level = newLevel
        equipment.stack = newStack
        updatePlayerEquipmentSync(playerId, equipmentId, { stack: newStack, level: newLevel })

        // give ability cores (CDN check: only if generate_ability_soul)
        const dissolveInfo = getEquipmentDissolveSync(equipmentId)
        if (dissolveInfo && dissolveInfo.generate_ability_soul) {
            returnItemList[dissolveInfo.ability_soul_id] = givePlayerItemSync(playerId, dissolveInfo.ability_soul_id, upgradeCount)
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": [clientSerializeEquipment(equipmentId, equipment)],
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    })

    // ── bulk_upgrade (one-click awakening) ─────────────────────────────
    fastify.post("/bulk_upgrade", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkUpgradeBody

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

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." })

        const upgrades: Array<{ equipmentId: number; upgradeCount: number }> = []
        let totalCraftPointCost = 0
        const seen = new Set<number>()

        for (const equipmentId of equipmentIds) {
            if (seen.has(equipmentId)) continue
            seen.add(equipmentId)
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (!equipment) continue

            const upgradeCount = Math.min(5 - equipment.level, equipment.stack)
            if (upgradeCount <= 0) continue

            const rarity = Math.floor(equipmentId / 1000000) - 1
            totalCraftPointCost += equipmentUpgradeCost[rarity] * upgradeCount
            upgrades.push({ equipmentId, upgradeCount })
        }

        if (upgrades.length === 0) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": { "equipment_list": [], "item_list": {}, "mail_arrived": false }
            })
        }

        const currentCraftPoints = getPlayerItemSync(playerId, wrightpieceItemId) ?? 0
        if (totalCraftPointCost > currentCraftPoints) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Not enough craft points." })
        }

        const returnEquipmentList: Object[] = []
        const returnItemList: Record<number, number> = {}

        for (const { equipmentId, upgradeCount } of upgrades) {
            const equipment = getPlayerEquipmentSync(playerId, equipmentId)!
            equipment.level += upgradeCount
            equipment.stack -= upgradeCount
            updatePlayerEquipmentSync(playerId, equipmentId, { level: equipment.level, stack: equipment.stack })
            returnEquipmentList.push(clientSerializeEquipment(equipmentId, equipment))
            const dissolveInfo = getEquipmentDissolveSync(equipmentId)
            if (dissolveInfo && dissolveInfo.generate_ability_soul) {
                returnItemList[dissolveInfo.ability_soul_id] = givePlayerItemSync(playerId, dissolveInfo.ability_soul_id, upgradeCount)
            }
        }

        const newCraftPoints = currentCraftPoints - totalCraftPointCost
        updatePlayerItemSync(playerId, wrightpieceItemId, newCraftPoints)
        returnItemList[wrightpieceItemId] = newCraftPoints

        console.log(`[BULK_UPGRADE] account=${accountId} player=${playerId}: ${upgrades.length} equipment upgraded, craft points ${currentCraftPoints} -> ${newCraftPoints}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "equipment_list": returnEquipmentList, "item_list": returnItemList, "mail_arrived": false }
        })
    })

    // ── set_protection (equipment lock) ────────────────────────────────
    fastify.post("/set_protection", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetProtectionBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const playerId = resolvePlayerIdSync(session.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null
        if (!player) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        const newProtection = body.protection
        for (const equipmentId of body.equipment_ids) {
            if (playerOwnsEquipmentSync(playerId, equipmentId)) {
                updatePlayerEquipmentSync(playerId, equipmentId, { protection: newProtection })
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })
}

export default routes;
