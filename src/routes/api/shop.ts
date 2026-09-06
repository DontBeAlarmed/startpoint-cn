// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    getPlayerShopPurchaseCountsByTypeBulkSync,
} from "../../data/domains/shopPurchase"
import {
    getPlayerShopCampaignLineupSync,
    getPlayerShopCampaignLineupsSync,
    selectPlayerShopCampaignLineupSync,
} from "../../data/domains/shop-campaign-lineup"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getShopSelectItemCampaignsSync } from "../../lib/assets";
import { getStaminaPolicySync } from "../../lib/config-content"
import { ShopType } from "../../lib/types";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { computeRealTimeStamina } from "../../lib/stamina";
import { getMailArrivedSync } from "../../lib/mail-notification";
import {
    isShopItemVisibleForCampaign,
    requireAvailableShopCampaign,
    ShopCampaignPeriodError,
    ShopCampaignValidationError,
} from "../../lib/shop-select-campaign";
import { buildShopSalesListSync } from "../../lib/shop-sales-list";
import { getGameTimeContext, getRealNow } from "../../runtime/time/game-time"
import { planFreeFirstDeduction } from "../../lib/economy/free-first-deduction"
import { registerShopPurchaseRoutes } from "./shop/purchase-routes"
import { getShopCatalog } from "../../lib/shop"
import { selectShopSalesCatalogItems } from "../../lib/shop/sales-catalog"

interface GetSalesListBody {
    equipment_enhancement_shop_category_ids: number[],
    boss_coin_shop_category_ids: number[],
    browse_treasure_flag: boolean,
    shop_types: ShopType[],
    event_list: {
        event_type: number,
        event_ids: number[]
    }[],
    viewer_id: number
}

export interface ShopRoutesOptions {
    readonly dailyResetHour?: number
}

const routes = async (fastify: FastifyInstance, options: ShopRoutesOptions = {}) => {
    const dailyResetHour = options.dailyResetHour ?? 5
    registerShopPurchaseRoutes(fastify, dailyResetHour)

    fastify.post("/get_sales_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetSalesListBody

        const viewerId = body.viewer_id
        const shopTypes = body.shop_types
        const bossCoinShopCategoryIds = body.boss_coin_shop_category_ids
        const equipmentEnhancementCategoryIds = body.equipment_enhancement_shop_category_ids
        const eventList = body.event_list
        if (isNaN(viewerId) || shopTypes === undefined || bossCoinShopCategoryIds === undefined || eventList === undefined) return reply.status(400).send({
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

        console.log(`[shop:req] viewer=${viewerId} types=${JSON.stringify(shopTypes)} bossCats=${JSON.stringify(bossCoinShopCategoryIds)} equipCats=${JSON.stringify(equipmentEnhancementCategoryIds)} events=${eventList.length} eventList=${JSON.stringify(eventList)}`)

        const toParseShopItems = selectShopSalesCatalogItems(getShopCatalog(), {
            shopTypes,
            eventList: eventList.map(event => ({
                eventType: event.event_type,
                eventIds: event.event_ids,
            })),
            bossCategoryIds: bossCoinShopCategoryIds,
        })

        const gameTime = getGameTimeContext()
        const nowMs = gameTime.virtualNowMs
        const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
        const equipmentSnapshot = shopTypes.includes(ShopType.TREASURE_EQUIPMENT)
            ? getPlayerEquipmentListSync(playerId)
            : null
        const { salesList, filteredGeneralCount } = buildShopSalesListSync({
            playerId,
            itemsByType: toParseShopItems,
            nowMs,
            purchasePeriodNowMs: gameTime.realNowMs,
            resetHour: dailyResetHour,
            equipmentEnhancementCategoryIds,
            isItemVisible: (item, shopType) => (
                isShopItemVisibleForCampaign(item, shopType, campaignLineups)
            ),
        }, {
            getPurchaseCountsBulk: getPlayerShopPurchaseCountsByTypeBulkSync,
            getEquipmentEnhancementLevel: (ownerId, equipmentId) => (
                equipmentSnapshot === null
                    ? -1
                    : (equipmentSnapshot[String(equipmentId)]?.enhancementLevel ?? -1)
            ),
        })

        if (filteredGeneralCount > 0) {
            console.log(`[shop] Filtered ${filteredGeneralCount} general shop items not in CDN master data`)
        }

        const salesByType: Record<number, number> = {}
        for (const item of salesList) {
            const t = (item as any).shop_type
            salesByType[t] = (salesByType[t] || 0) + 1
        }
        console.log(`[shop:res] totalSales=${salesList.length} byType=${JSON.stringify(salesByType)} toParseItems=${JSON.stringify(Object.fromEntries(Object.entries(toParseShopItems).map(([k,v]) => [k, Object.keys(v).length])))}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "sales_list": salesList
            }
        })
    })

    fastify.post("/recover_stamina", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, api_count: number }
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) {
            console.warn(`[RECOVER-STAMINA] invalid viewer_id: ${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer_id."
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            "error": "Internal Server Error", "message": "Player not found."
        })

        const staminaPolicy = getStaminaPolicySync()
        const recoveryCost = staminaPolicy.recoveryVmoneyCost
        const recoveryValue = staminaPolicy.recoveryValue
        const maxOverflow = staminaPolicy.maxOverflow

        const currentStamina = computeRealTimeStamina(player)

        // Already at max
        if (currentStamina >= maxOverflow) {
            console.log(`[RECOVER-STAMINA] player ${playerId} already at max (${currentStamina} >= ${maxOverflow})`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 2102 }),
                "data": {}
            })
        }

        const deduction = planFreeFirstDeduction(
            player.freeVmoney,
            player.vmoney,
            recoveryCost,
        )
        if (deduction === null) {
            console.warn(`[RECOVER-STAMINA] player ${playerId} insufficient vmoney: free=${player.freeVmoney} paid=${player.vmoney} cost=${recoveryCost}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 0 }),
                "data": {}
            })
        }

        // Calculate recovery amount (capped at overflow)
        const afterStamina = Math.min(currentStamina + recoveryValue, maxOverflow)
        const actualRecovery = afterStamina - currentStamina
        const recoveryTime = getRealNow()

        updatePlayerSync({
            id: playerId,
            stamina: afterStamina,
            staminaHealTime: recoveryTime,
            freeVmoney: deduction.freeBalance,
            vmoney: deduction.paidBalance,
        })

        console.log(`[RECOVER-STAMINA] player ${playerId}: stamina ${currentStamina}->${afterStamina} (+${actualRecovery}), freeVmoney ${player.freeVmoney}->${deduction.freeBalance}, vmoney ${player.vmoney}->${deduction.paidBalance}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "stamina": afterStamina,
                    "stamina_heal_time": realToVirtual(recoveryTime),
                    "vmoney": deduction.paidBalance,
                    "free_vmoney": deduction.freeBalance,
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })


    fastify.post("/get_campaign_lineup_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id?: number
            shop_type?: number
            campaign_id?: number
        }
        const viewerId = body.viewer_id
        const shopType = body.shop_type
        const campaignId = body.campaign_id
        if (!Number.isSafeInteger(viewerId) || viewerId! <= 0
            || (shopType !== ShopType.EVENT_ITEM && shopType !== ShopType.BOSS_COIN)
            || !Number.isSafeInteger(campaignId) || campaignId! <= 0) {
            return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
            })
        }
        const session = await getSession(String(viewerId))
        if (!session) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No players bound to account."
        })
        try {
            requireAvailableShopCampaign(
                getShopSelectItemCampaignsSync(),
                shopType,
                campaignId!,
                null,
                getServerTime() * 1000,
            )
        } catch (error) {
            if (error instanceof ShopCampaignPeriodError) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    "data_headers": generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: error.resultCode,
                    }),
                    "data": {},
                })
            }
            if (error instanceof ShopCampaignValidationError) return reply.status(400).send({
                "error": "Bad Request", "message": error.message,
            })
            throw error
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "lineup_id": getPlayerShopCampaignLineupSync(playerId, shopType, campaignId!),
            }
        })
    })

    fastify.post("/set_campaign_lineup_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id?: number
            shop_type?: number
            campaign_id?: number
            lineup_id?: number
        }
        const viewerId = body.viewer_id
        const shopType = body.shop_type
        const campaignId = body.campaign_id
        const lineupId = body.lineup_id
        if (!Number.isSafeInteger(viewerId) || viewerId! <= 0
            || (shopType !== ShopType.EVENT_ITEM && shopType !== ShopType.BOSS_COIN)
            || !Number.isSafeInteger(campaignId) || campaignId! <= 0
            || !Number.isSafeInteger(lineupId) || lineupId! <= 0) {
            return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
            })
        }
        const session = await getSession(String(viewerId))
        if (!session) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No players bound to account."
        })
        try {
            requireAvailableShopCampaign(
                getShopSelectItemCampaignsSync(),
                shopType,
                campaignId!,
                lineupId!,
                getServerTime() * 1000,
            )
        } catch (error) {
            if (error instanceof ShopCampaignPeriodError) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    "data_headers": generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: error.resultCode,
                    }),
                    "data": {},
                })
            }
            if (error instanceof ShopCampaignValidationError) return reply.status(400).send({
                "error": "Bad Request", "message": error.message,
            })
            throw error
        }
        const selectedAt = new Date(getServerTime() * 1000)
        const selectionResult = getDb().transaction(() => (
            selectPlayerShopCampaignLineupSync(
                playerId,
                shopType,
                campaignId!,
                lineupId!,
                selectedAt,
            )
        ))()
        if (selectionResult === "conflict") return reply.status(400).send({
            "error": "Bad Request",
            "message": "Shop campaign lineup has already been selected."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })
}

export default routes;
