// Equipment awakening and protection endpoints: upgrade, bulk_upgrade, set_protection.
// Dismantle/sell endpoints are in sell.ts (same /equipment prefix).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerEquipmentListSync, getPlayerEquipmentSync, getPlayerEquipmentsByIdsSync, playerOwnsEquipmentSync,
    normalizeEquipmentBatchIds, updatePlayerEquipmentSync,
} from "../../data/domains/equipment";
import {
    getPlayerItemSync, givePlayerItemSync, updatePlayerItemSync,
} from "../../data/domains/item";
import { getPlayerSync } from "../../data/domains/player";
import { getSession } from "../../data/domains/session";
import { generateDataHeaders, getServerDate } from "../../utils";
import { clientSerializeEquipment, buildFullEquipmentList, serializeFullEquipmentList } from "../../lib/equipment";
import { getEquipmentDissolveSync, getConfigSync, getEquipmentCraftSync } from "../../lib/assets";
import { AccountId, PlayerId } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDb } from "../../data/db";
import { canUseEquipmentAwakeningCrystal } from "../../lib/equipment-upgrade";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { settleMissionOperationFactsSync } from "../../lib/mission/operation-fact-settlement";
import { mergeMissionSettlementResponse } from "../../lib/mission";

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

const wrightpieceItemId = () => getConfigSync().craft_point_item_id || 100000

// wrightpiece cost for each rank of weapon (awakening) — from CDN
const getUpgradeCost = (rarity: number): number => getEquipmentCraftSync(rarity)?.awakening_craft ?? 25

const routes = async (fastify: FastifyInstance) => {

    // ── upgrade (single equipment awakening) ───────────────────────────
    fastify.post("/upgrade", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpgradeBody

        const viewerId = body.viewer_id
        const upgradeCount = body.upgrade_count
        const useStack = body.use_stack
        const itemId = body.item_id
        const equipmentId = body.equipment_id
        if (isNaN(viewerId) || isNaN(equipmentId) || typeof useStack !== "boolean"
            || !Number.isInteger(upgradeCount) || upgradeCount <= 0) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        const equipment = getPlayerEquipmentSync(playerId, equipmentId)
        if (!equipment) return reply.status(400).send({ "error": "Bad Request", "message": "Player does not own equipment." })

        const cdnInfo = getEquipmentDissolveSync(equipmentId)
        const maxLevel = cdnInfo?.max_level ?? 5
        const newLevel = equipment.level + upgradeCount
        if (newLevel > maxLevel) return reply.status(400).send({ "error": "Bad Request", "message": "Reached max awakening level." })

        const newStack = useStack ? equipment.stack - upgradeCount : equipment.stack
        if (newStack < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough stack." })

        const equipmentRarity = Math.floor(equipmentId / 1000000)  // 1-indexed
        if (!useStack && (itemId === undefined || !canUseEquipmentAwakeningCrystal(itemId, equipmentRarity))) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid awakening material for equipment rarity." })
        }
        const wrightPieces = getPlayerItemSync(playerId, wrightpieceItemId()) ?? 0
        const upgradeCost = getUpgradeCost(equipmentRarity)
        const newWrightPieces = wrightPieces - (upgradeCost * upgradeCount)
        if (newWrightPieces < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough of wrightpieces." })

        const itemCount = itemId ? getPlayerItemSync(playerId, itemId) ?? 0 : 0
        const newItemCount = !useStack ? itemCount - upgradeCount : itemCount
        if (newItemCount < 0) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough of item." })

        const returnItemList: Record<string, number> = {}

        const dissolveInfo = getEquipmentDissolveSync(equipmentId)
        const operationResult = getDb().transaction(() => {
            if (!useStack && itemId !== undefined) {
                returnItemList[itemId] = newItemCount
                updatePlayerItemSync(playerId, itemId, newItemCount)
            }

            returnItemList[wrightpieceItemId()] = newWrightPieces
            updatePlayerItemSync(playerId, wrightpieceItemId(), newWrightPieces)
            updatePlayerEquipmentSync(playerId, equipmentId, { stack: newStack, level: newLevel })
            const equipmentSnapshot = getPlayerEquipmentListSync(playerId)
            const missionSettlement = settleMissionOperationFactsSync(
                playerId,
                "equipment_upgrade",
                upgradeCount,
                getServerDate(),
                equipmentSnapshot,
            )

            if (dissolveInfo && dissolveInfo.generate_ability_soul) {
                returnItemList[dissolveInfo.ability_soul_id] = givePlayerItemSync(playerId, dissolveInfo.ability_soul_id, upgradeCount)
            }
            return { equipmentSnapshot, missionSettlement }
        })()

        equipment.level = newLevel
        equipment.stack = newStack

        const returnEquipmentList = serializeFullEquipmentList(operationResult.equipmentSnapshot)

        console.log(`[UPGRADE] account=${accountId} player=${playerId}: eid=${equipmentId} rarity=${equipmentRarity} level ${equipment.level-upgradeCount}->${equipment.level} stack ${equipment.stack+upgradeCount}->${equipment.stack} craft -${upgradeCost*upgradeCount}`)

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, unknown> = {
            equipment_list: returnEquipmentList,
            item_list: returnItemList,
            mission_info: [],
            degree_list: [],
            mail_arrived: getMailArrivedSync(playerId),
        }
        if (operationResult.missionSettlement) {
            mergeMissionSettlementResponse(responseData, operationResult.missionSettlement, viewerId)
        }
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData,
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
        const uniqueEquipmentIds = normalizeEquipmentBatchIds(equipmentIds)
        if (uniqueEquipmentIds === null) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." })

        const equipmentSnapshot = getPlayerEquipmentsByIdsSync(playerId, uniqueEquipmentIds)
        const upgrades: Array<{
            equipmentId: number
            upgradeCount: number
            newLevel: number
            newStack: number
            abilitySoulId: number | null
        }> = []
        let totalCraftPointCost = 0

        for (const equipmentId of uniqueEquipmentIds) {
            const equipment = equipmentSnapshot[equipmentId]
            if (!equipment) continue

            const dissolveInfo = getEquipmentDissolveSync(equipmentId)
            const maxLvl = dissolveInfo?.max_level ?? 5
            const upgradeCount = Math.min(maxLvl - equipment.level, equipment.stack)
            if (upgradeCount <= 0) continue

            const rarity = Math.floor(equipmentId / 1000000)  // 1-indexed
            totalCraftPointCost += getUpgradeCost(rarity) * upgradeCount
            upgrades.push({
                equipmentId,
                upgradeCount,
                newLevel: equipment.level + upgradeCount,
                newStack: equipment.stack - upgradeCount,
                abilitySoulId: dissolveInfo?.generate_ability_soul
                    ? dissolveInfo.ability_soul_id
                    : null,
            })
        }

        if (upgrades.length === 0) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": { "equipment_list": [], "item_list": {}, "mail_arrived": getMailArrivedSync(playerId) }
            })
        }

        const currentCraftPoints = getPlayerItemSync(playerId, wrightpieceItemId()) ?? 0
        if (totalCraftPointCost > currentCraftPoints) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Not enough craft points." })
        }

        const returnItemList: Record<number, number> = {}

        const newCraftPoints = currentCraftPoints - totalCraftPointCost
        const operationResult = getDb().transaction(() => {
            for (const upgrade of upgrades) {
                updatePlayerEquipmentSync(playerId, upgrade.equipmentId, {
                    level: upgrade.newLevel,
                    stack: upgrade.newStack,
                })
                if (upgrade.abilitySoulId !== null) {
                    returnItemList[upgrade.abilitySoulId] = givePlayerItemSync(
                        playerId,
                        upgrade.abilitySoulId,
                        upgrade.upgradeCount,
                    )
                }
            }
            updatePlayerItemSync(playerId, wrightpieceItemId(), newCraftPoints)
            const equipmentSnapshot = getPlayerEquipmentListSync(playerId)
            const missionSettlement = settleMissionOperationFactsSync(
                playerId,
                "equipment_upgrade",
                upgrades.reduce((total, entry) => total + entry.upgradeCount, 0),
                getServerDate(),
                equipmentSnapshot,
            )
            return { equipmentSnapshot, missionSettlement }
        })()
        returnItemList[wrightpieceItemId()] = newCraftPoints

        console.log(`[BULK_UPGRADE] account=${accountId} player=${playerId}: ${upgrades.length} equipment upgraded, craft points ${currentCraftPoints} -> ${newCraftPoints}`)

        const returnEquipmentList = serializeFullEquipmentList(operationResult.equipmentSnapshot)

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, unknown> = {
            equipment_list: returnEquipmentList,
            item_list: returnItemList,
            mission_info: [],
            degree_list: [],
            mail_arrived: getMailArrivedSync(playerId),
        }
        if (operationResult.missionSettlement) {
            mergeMissionSettlementResponse(responseData, operationResult.missionSettlement, viewerId)
        }
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": responseData,
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
        getDb().transaction(() => {
            for (const equipmentId of body.equipment_ids) {
                if (playerOwnsEquipmentSync(playerId, equipmentId)) {
                    updatePlayerEquipmentSync(playerId, equipmentId, { protection: newProtection })
                }
            }
        })()

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": buildFullEquipmentList(playerId),
                "mail_arrived": getMailArrivedSync(playerId),
            }
        })
    })
}

export default routes;
