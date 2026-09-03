// Equipment dismantle/sell endpoints: sell_equipment, sell_stack, bulk_sell_stack.
// Registered under /api/index.php/equipment prefix (shared with equipment.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    deletePlayerEquipmentSync, getPlayerEquipmentSync, getPlayerEquipmentsByIdsSync,
    normalizeEquipmentBatchIds, updatePlayerEquipmentSync,
} from "../../data/domains/equipment";
import { getSession } from "../../data/domains/session";
import { generateDataHeaders } from "../../utils";
import { clientSerializeEquipment, buildFullEquipmentList } from "../../lib/equipment";
import { calculateDissolveRewards } from "../../lib/equipment-dissolve";
import { asAccountId, asPlayerId, AccountId, PlayerId } from "../../lib/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getConfigSync } from "../../lib/assets";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";
import { withInventoryBatchContextWithinTransactionSync } from "../../lib/inventory";
import { createRewardGrantItemOverflowPolicy } from "../../lib/reward-grant-item-overflow";
import {
    projectItemOverflowCommonResponse,
    settleDirectItemOverflowsWithinTransactionSync,
    type PlannedItemOverflowDisposition,
} from "../../lib/item-overflow";

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

function grantDissolveRewardsWithinTransactionSync(
    playerId: number,
    craftPoints: number,
    starGrains: number,
    abilitySouls: Readonly<Record<number, number>>,
): {
    itemList: Record<number, number>
    itemOverflowDispositions: readonly PlannedItemOverflowDisposition[]
    overflowFreeManaAfter: number | null
} {
    const grants = [
        ...(craftPoints > 0 ? [{ itemId: wrightpieceItemId(), amount: craftPoints }] : []),
        ...(starGrains > 0 ? [{ itemId: starGrainItemId(), amount: starGrains }] : []),
        ...Object.entries(abilitySouls).map(([itemId, amount]) => ({
            itemId: Number(itemId),
            amount,
        })),
    ]
    if (grants.length === 0) {
        return { itemList: {}, itemOverflowDispositions: [], overflowFreeManaAfter: null }
    }

    return withInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: grants.map(grant => grant.itemId),
    }, inventory => {
        const itemList: Record<number, number> = {}
        const overflowPolicy = createRewardGrantItemOverflowPolicy(playerId)
        const pendingOverflows: Array<{ itemId: number, amount: number }> = []
        for (const grant of grants) {
            const item = inventory.grantWithCapacity(
                grant.itemId,
                grant.amount,
                overflowPolicy.maxCount(grant.itemId),
            )
            itemList[grant.itemId] = item.afterAmount
            if (item.overflowAmount > 0) {
                pendingOverflows.push({ itemId: grant.itemId, amount: item.overflowAmount })
            }
        }
        inventory.flush()
        const overflowSettlement = pendingOverflows.length === 0
            ? null
            : settleDirectItemOverflowsWithinTransactionSync({
                playerId,
                overflows: pendingOverflows,
            })
        return {
            itemList,
            itemOverflowDispositions: overflowSettlement?.dispositions ?? [],
            overflowFreeManaAfter: overflowSettlement?.freeManaAfter ?? null,
        }
    })
}

function overflowResponseFields(settlement: ReturnType<
    typeof grantDissolveRewardsWithinTransactionSync
>): Record<string, unknown> {
    const overMax = projectItemOverflowCommonResponse(settlement.itemOverflowDispositions)
    return {
        ...(overMax.length > 0 ? { over_max: overMax } : {}),
        ...(settlement.itemOverflowDispositions.some(entry => entry.kind === "sold")
            ? { user_info: { free_mana: settlement.overflowFreeManaAfter } }
            : {}),
    }
}

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

        const rewardSettlement = getDb().transaction(() => {
            for (const equipmentId of soldIds) {
                deletePlayerEquipmentSync(playerId, equipmentId)
            }
            return grantDissolveRewardsWithinTransactionSync(
                playerId,
                totalCraftPoints,
                totalStarGrains,
                totalAbilitySouls,
            )
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
                "item_list": rewardSettlement.itemList,
                "mail_arrived": getMailArrivedSync(playerId),
                ...overflowResponseFields(rewardSettlement),
            }
        })
    })

    // ── sell_stack (partial stack sale) ─────────────────────────────────
    fastify.post("/sell_stack", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellBody

        const viewerId = body.viewer_id
        const toSellEquipmentList = body.equipment_list
        if (isNaN(viewerId) || !Array.isArray(toSellEquipmentList)) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }
        const uniqueEquipmentIds = normalizeEquipmentBatchIds(
            toSellEquipmentList.map(toSell => toSell?.equipment_id),
        )
        if (uniqueEquipmentIds === null) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        }

        const requestedCounts = new Map<number, number>()
        for (const toSell of toSellEquipmentList) {
            const sellCount = (toSell as SellStackEquipmentListItem).number
            if (!Number.isSafeInteger(sellCount) || sellCount <= 0) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Invalid sell count." })
            }
            const requestedCount = (requestedCounts.get(toSell.equipment_id) ?? 0) + sellCount
            if (!Number.isSafeInteger(requestedCount)) {
                return reply.status(400).send({ "error": "Bad Request", "message": "Invalid sell count." })
            }
            requestedCounts.set(toSell.equipment_id, requestedCount)
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." })

        const accountId = session.accountId as AccountId
        const playerId = resolvePlayerIdSync(accountId)! as PlayerId
        if (playerId === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "No players bound to account." })

        let totalCraftPoints = 0
        let totalStarGrains = 0
        const totalAbilitySouls: Record<number, number> = {}
        const equipmentSnapshot = getPlayerEquipmentsByIdsSync(playerId, uniqueEquipmentIds)
        const stackUpdates: Array<{ equipmentId: number, newStack: number }> = []

        for (const [equipmentId, sellCount] of requestedCounts) {
            const equipment = equipmentSnapshot[equipmentId]
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

        const rewardSettlement = getDb().transaction(() => {
            for (const update of stackUpdates) {
                updatePlayerEquipmentSync(playerId, update.equipmentId, { stack: update.newStack })
            }
            return grantDissolveRewardsWithinTransactionSync(
                playerId,
                totalCraftPoints,
                totalStarGrains,
                totalAbilitySouls,
            )
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
                "item_list": rewardSettlement.itemList,
                "mail_arrived": getMailArrivedSync(playerId),
                ...overflowResponseFields(rewardSettlement),
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
        const uniqueEquipmentIds = normalizeEquipmentBatchIds(equipmentIds)
        if (uniqueEquipmentIds === null) {
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
        const equipmentSnapshot = getPlayerEquipmentsByIdsSync(playerId, uniqueEquipmentIds)

        for (const equipmentId of uniqueEquipmentIds) {
            const equipment = equipmentSnapshot[equipmentId]
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

        const rewardSettlement = getDb().transaction(() => {
            for (const equipmentId of toSell) {
                updatePlayerEquipmentSync(playerId, equipmentId, { stack: 0 })
            }
            return grantDissolveRewardsWithinTransactionSync(
                playerId,
                totalCraftPoints,
                totalStarGrains,
                totalAbilitySouls,
            )
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
                "item_list": rewardSettlement.itemList,
                "mail_arrived": getMailArrivedSync(playerId),
                ...overflowResponseFields(rewardSettlement),
            }
        })
    })
}

export default routes;
