// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    addPlayerShopPurchaseCountsByTypeSync,
    getPlayerShopPurchaseCountSnapshotSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
} from "../../data/domains/shopPurchase"
import {
    getPlayerShopCampaignLineupSync,
    getPlayerShopCampaignLineupsSync,
    selectPlayerShopCampaignLineupSync,
} from "../../data/domains/shop-campaign-lineup"
import { getAccountPlayers } from "../../data/domains/account"
import { getPlayerEquipmentListSync, getPlayerEquipmentSync, updatePlayerEquipmentSync } from "../../data/domains/equipment"
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { incrementActiveMissionUsedManaCountSync } from "../../data/domains/active_mission_counters";
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getBossCoinShopItemsSync, getConfigSync, getEventShopItemsSync, getGenericShopItemsSync, getShopItemSync, getShopSelectItemCampaignsSync } from "../../lib/assets";
import { ShopItem, ShopItems, ShopItemUserCostType, ShopType } from "../../lib/types";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { grantShopRewardsInTransactionOwnerSync } from "../../lib/shop-reward-grant";
import { computeRealTimeStamina } from "../../lib/stamina";
import { clientSerializeEquipment } from "../../lib/equipment";
import { planEquipmentEnhancementPurchase } from "../../lib/equipment-enhancement";
import { reconcileAwakeUnlockCharacterList } from "../../lib/mission";
import {
    executeGenericShopBatchPurchaseSync,
    executeGenericShopPurchaseSync,
    getShopPurchasePeriodKeys,
    recordEquipmentEnhancementPurchaseSync,
    ShopPeriodError,
    ShopPurchaseError,
    validateShopPurchaseAmount,
} from "../../lib/event-shop-purchase";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { recordMissionOperationFactsSync } from "../../lib/mission/degree-operation-facts";
import {
    isShopItemVisibleForCampaign,
    requireAvailableShopCampaign,
    ShopCampaignPeriodError,
    ShopCampaignValidationError,
} from "../../lib/shop-select-campaign";
import { buildShopSalesListSync } from "../../lib/shop-sales-list";
import {
    addPlayerPassCardPointSync,
} from "../../data/domains/pass-card"
import { getActivePassCardEventDefinitionAt } from "../../lib/pass-card"

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

interface BuyBody {
    shop_type: number,
    api_count: number,
    shop_item_id: number,
    number: number,
    viewer_id: number
}

interface BulkBuyBody {
    shop_type: number
    buy_item_list: Record<string, unknown>
    viewer_id: number
    api_count?: number
    retry_count?: number
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/buy", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BuyBody

        const viewerId = body.viewer_id
        const shopType = body.shop_type
        const rawPurchaseAmount = body.number
        const shopItemId = body.shop_item_id
        if (isNaN(viewerId) || isNaN(shopType) || isNaN(shopItemId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        let purchaseAmount: number
        try {
            purchaseAmount = validateShopPurchaseAmount(rawPurchaseAmount)
        } catch {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Purchase amount must be a positive integer."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get the shop item's data
        const shopItemData = getShopItemSync(shopType, shopItemId)
        if (shopItemData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Shop item with specified id does not exist."
        })
        if (!isShopItemVisibleForCampaign(
            shopItemData,
            shopType,
            getPlayerShopCampaignLineupsSync(playerId),
        )) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Shop campaign lineup is not selected."
        })

        // buy_max_count is a per-request limit, not lifetime stock.
        if (shopItemData.stock >= 0 && purchaseAmount > shopItemData.stock) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Shop item purchase limit reached."
            })
        }

        let enhancementEquipmentId: number | null = null
        let enhancementNewLevel: number | null = null
        if (shopType === ShopType.TREASURE_EQUIPMENT) {
            const equipmentId = shopItemData.equipmentId
            const stageMaxLevel = shopItemData.enhancementMaxLevel
            const requiredAwakeningLevel = shopItemData.requireAwakeningLevel
            if (equipmentId === undefined || stageMaxLevel === undefined || requiredAwakeningLevel === undefined) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Enhancement item is missing equipment progression data."
                })
            }

            const currentEquipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (currentEquipment === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Player does not own the target equipment."
            })

            const groupItems = Object.entries(getGenericShopItemsSync(ShopType.TREASURE_EQUIPMENT) ?? {})
                .filter(([, item]) => item.groupId === shopItemData.groupId && item.equipmentId === equipmentId)
                .sort(([, a], [, b]) => (a.stage ?? 0) - (b.stage ?? 0))
            const currentStage = groupItems.find(([, item]) =>
                (item.enhancementMaxLevel ?? 0) > currentEquipment.enhancementLevel
            )
            if (!currentStage || Number(currentStage[0]) !== shopItemId) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Enhancement item is not the current stage."
                })
            }

            const plan = planEquipmentEnhancementPurchase(
                currentEquipment.enhancementLevel,
                purchaseAmount,
                stageMaxLevel,
                currentEquipment.level,
                requiredAwakeningLevel,
            )
            if (!plan.ok) return reply.status(400).send({
                "error": "Bad Request",
                "message": plan.message
            })

            enhancementEquipmentId = equipmentId
            enhancementNewLevel = plan.newLevel
        }

        console.log(`[shop:buy] player=${playerId} shopType=${shopType} item=${shopItemId} x${purchaseAmount} before freeMana=${player.freeMana} freeVmoney=${player.freeVmoney}`)

        // Equipment enhancement shop: update equipment enhancement level
        if (shopType === ShopType.TREASURE_EQUIPMENT) {
            const itemList: Record<string, number> = {}
            let freeVmoney = player.freeVmoney
            let freeMana = player.freeMana
            let bondTokens = player.bondToken
            const userCost = shopItemData.userCost
            if (userCost !== undefined) {
                const amount = userCost.amount * purchaseAmount
                switch (userCost.type) {
                    case ShopItemUserCostType.MANA:
                        freeMana -= amount
                        break
                    case ShopItemUserCostType.BEADS:
                        freeVmoney -= amount
                        break
                    case ShopItemUserCostType.AMITY_SCROLL:
                        bondTokens -= amount
                        break
                }
            }
            if (freeVmoney < 0 || freeMana < 0 || bondTokens < 0) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Not enough currency to purchase shop item."
                })
            }
            for (const cost of shopItemData.costs) {
                const nextAmount = (getPlayerItemSync(playerId, cost.id) ?? 0) - cost.amount * purchaseAmount
                if (nextAmount < 0) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": `Not enough of item with id ${cost.id} to purchase shop item.`
                })
                itemList[String(cost.id)] = nextAmount
            }

            const equipmentId = enhancementEquipmentId!
            const newLevel = enhancementNewLevel!
            const manaSpent = player.freeMana - freeMana
            getDb().transaction(() => {
                for (const [itemId, nextAmount] of Object.entries(itemList)) {
                    updatePlayerItemSync(playerId, itemId, nextAmount)
                }
                updatePlayerSync({
                    id: playerId,
                    freeMana,
                    freeVmoney,
                    bondToken: bondTokens,
                })
                updatePlayerEquipmentSync(playerId, equipmentId, { enhancementLevel: newLevel })
                incrementActiveMissionUsedManaCountSync(playerId, manaSpent)
                recordEquipmentEnhancementPurchaseSync({
                    playerId,
                    shopType,
                    shopItemId,
                    purchaseAmount,
                    nowMs: getServerTime() * 1000,
                    specifiedMonths: shopItemData.specifiedMonths,
                }, {
                    getShopPurchasePeriodKeys,
                    addPurchaseCounts: addPlayerShopPurchaseCountsByTypeSync,
                })
            })()

            const currentEquipment = getPlayerEquipmentSync(playerId, equipmentId)!

            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": {
                        "free_vmoney": freeVmoney,
                        "free_mana": freeMana,
                        "bond_token": bondTokens
                    },
                    "character_list": [],
                    "equipment_list": [clientSerializeEquipment(equipmentId, currentEquipment)],
                    "item_list": itemList,
                    "mail_arrived": getMailArrivedSync(playerId)
                }
            })
        }

        let purchaseResult
        try {
            purchaseResult = executeGenericShopPurchaseSync({
                playerId,
                shopType,
                shopItemId,
                purchaseAmount,
                shopItem: shopItemData,
                nowMs: getServerTime() * 1000,
                enforcePeriod: shopType === ShopType.EVENT_ITEM,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getPlayer: getPlayerSync,
                updatePlayer: nextPlayer => updatePlayerSync(nextPlayer),
                getItem: (id, itemId) => getPlayerItemSync(id, itemId) ?? 0,
                setItem: updatePlayerItemSync,
                getPurchaseCounts: getPlayerShopPurchaseCountSnapshotSync,
                addPurchaseCounts: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
                recordManaSpent: (id, amount) => {
                    incrementActiveMissionUsedManaCountSync(id, amount)
                    if (shopType === ShopType.TREASURE) {
                        recordMissionOperationFactsSync(id, "treasure_mana", amount)
                    }
                },
                grantRewards: grantShopRewardsInTransactionOwnerSync,
                grantPassCardPoints: (id, amount) => {
                    const activeEvent = getActivePassCardEventDefinitionAt(new Date(getServerTime() * 1000))
                    if (!activeEvent) throw new ShopPurchaseError("No active pass card.")
                    addPlayerPassCardPointSync(id, activeEvent.eventId, amount, activeEvent.thresholdPoint)
                },
            })
        } catch (error) {
            if (error instanceof ShopPeriodError) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    "data_headers": generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: error.resultCode,
                    }),
                    "data": {}
                })
            }
            if (error instanceof ShopPurchaseError) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }

        const rewardResult = purchaseResult.rewardResult
        const characterList = reconcileAwakeUnlockCharacterList(
            playerId,
            rewardResult.character_list as Record<string, unknown>[]
        )

        const afterPlayer = purchaseResult.player
        console.log(`[shop:buy] after DB freeMana=${afterPlayer.freeMana} freeVmoney=${afterPlayer.freeVmoney} rewardItems=${JSON.stringify(rewardResult?.items ?? {})}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "vmoney": afterPlayer.vmoney,
                    "free_vmoney": afterPlayer.freeVmoney,
                    "free_mana": afterPlayer.freeMana,
                    "bond_token": afterPlayer.bondToken,
                    "exp_pool": afterPlayer.expPool,
                },
                "character_list": characterList,
                "equipment_list": rewardResult.equipment_list,
                "item_list": purchaseResult.itemList,
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

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

        let toParseShopItems: Record<number, ShopItems> = {}

        // shop types
        for (const type of shopTypes) {
            const items = getGenericShopItemsSync(type)
            const existing = toParseShopItems[type] ?? {}
            toParseShopItems[type] = items === null ? existing : { ...existing, ...items }
        }

        // event list
        for (const event of eventList) {
            const type = event.event_type
            for (const eventId of event.event_ids) {
                const items = getEventShopItemsSync(type, eventId)
                const existing = toParseShopItems[ShopType.EVENT_ITEM] ?? {}
                toParseShopItems[ShopType.EVENT_ITEM] = items === null ? existing : { ...existing, ...items }
            }
        }

        // boss coin shop category ids
        for (const category of bossCoinShopCategoryIds) {
            const items = getBossCoinShopItemsSync(category)
            const existing = toParseShopItems[ShopType.BOSS_COIN] ?? {}
            toParseShopItems[ShopType.BOSS_COIN] = items === null ? existing : { ...existing, ...items }
        }

        const nowMs = getServerTime() * 1000
        const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
        const equipmentSnapshot = shopTypes.includes(ShopType.TREASURE_EQUIPMENT)
            ? getPlayerEquipmentListSync(playerId)
            : null
        const { salesList, filteredGeneralCount } = buildShopSalesListSync({
            playerId,
            itemsByType: toParseShopItems,
            nowMs,
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

        const config = getConfigSync()
        const recoveryCost = config.stamina_recovery_virtual_money
        const recoveryValue = config.stamina_recovery_value
        const maxOverflow = config.max_stamina_overflow

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

        // Insufficient vmoney
        const freeVmoney = player.freeVmoney
        if (freeVmoney < recoveryCost) {
            console.warn(`[RECOVER-STAMINA] player ${playerId} insufficient vmoney: ${freeVmoney} < ${recoveryCost}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 0 }),
                "data": {}
            })
        }

        // Calculate recovery amount (capped at overflow)
        const afterStamina = Math.min(currentStamina + recoveryValue, maxOverflow)
        const actualRecovery = afterStamina - currentStamina
        const recoveryTime = new Date()

        updatePlayerSync({
            id: playerId,
            stamina: afterStamina,
            staminaHealTime: recoveryTime,
            freeVmoney: freeVmoney - recoveryCost
        })

        console.log(`[RECOVER-STAMINA] player ${playerId}: stamina ${currentStamina}->${afterStamina} (+${actualRecovery}), freeVmoney ${freeVmoney}->${freeVmoney - recoveryCost}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "stamina": afterStamina,
                    "stamina_heal_time": realToVirtual(recoveryTime),
                    "free_vmoney": freeVmoney - recoveryCost
                },
                "mail_arrived": getMailArrivedSync(playerId)
            }
        })
    })

    fastify.post("/bulk_buy", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkBuyBody
        const viewerId = body.viewer_id
        const shopType = body.shop_type
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || (shopType !== ShopType.EVENT_ITEM && shopType !== ShopType.BOSS_COIN)
            || body.buy_item_list === null
            || typeof body.buy_item_list !== "object"
            || Array.isArray(body.buy_item_list)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const rawEntries = Object.entries(body.buy_item_list)
        if (rawEntries.length === 0) return reply.status(400).send({
            "error": "Bad Request", "message": "Bulk purchase must contain at least one item."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No players bound to account."
        })

        const purchases: Array<{ shopItemId: number, purchaseAmount: number, shopItem: ShopItem }> = []
        const campaignLineups = getPlayerShopCampaignLineupsSync(playerId)
        try {
            for (const [shopItemIdText, rawAmount] of rawEntries) {
                if (!/^[1-9]\d*$/.test(shopItemIdText)) throw new ShopPurchaseError("Invalid shop item id.")
                const shopItemId = Number(shopItemIdText)
                if (!Number.isSafeInteger(shopItemId)) throw new ShopPurchaseError("Invalid shop item id.")
                const purchaseAmount = validateShopPurchaseAmount(rawAmount)
                const shopItem = getShopItemSync(shopType, shopItemId)
                if (shopItem === null) throw new ShopPurchaseError("Shop item with specified id does not exist.")
                if (!isShopItemVisibleForCampaign(
                    shopItem,
                    shopType,
                    campaignLineups,
                )) throw new ShopPurchaseError("Shop campaign lineup is not selected.")
                purchases.push({ shopItemId, purchaseAmount, shopItem })
            }
        } catch (error) {
            if (error instanceof ShopPurchaseError) return reply.status(400).send({
                "error": "Bad Request", "message": error.message,
            })
            throw error
        }

        let purchaseResult
        try {
            purchaseResult = executeGenericShopBatchPurchaseSync({
                playerId,
                shopType,
                purchases,
                nowMs: getServerTime() * 1000,
                enforcePeriod: shopType === ShopType.EVENT_ITEM,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getPlayer: getPlayerSync,
                updatePlayer: nextPlayer => updatePlayerSync(nextPlayer),
                getItem: (id, itemId) => getPlayerItemSync(id, itemId) ?? 0,
                setItem: updatePlayerItemSync,
                getPurchaseCountsBulk: getPlayerShopPurchaseCountsByTypeBulkSync,
                addPurchaseCountsFromSnapshot: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
                recordManaSpent: incrementActiveMissionUsedManaCountSync,
                grantRewards: grantShopRewardsInTransactionOwnerSync,
            })
        } catch (error) {
            if (error instanceof ShopPeriodError) {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    "data_headers": generateDataHeaders({
                        viewer_id: viewerId,
                        result_code: error.resultCode,
                    }),
                    "data": {},
                })
            }
            if (error instanceof ShopPurchaseError) return reply.status(400).send({
                "error": "Bad Request", "message": error.message,
            })
            throw error
        }

        const afterPlayer = purchaseResult.player
        const rewardResult = purchaseResult.rewardResult
        const characterList = reconcileAwakeUnlockCharacterList(
            playerId,
            rewardResult.character_list as Record<string, unknown>[],
        )
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "free_vmoney": afterPlayer.freeVmoney,
                    "free_mana": afterPlayer.freeMana,
                    "bond_token": afterPlayer.bondToken,
                    "exp_pool": afterPlayer.expPool,
                },
                "character_list": characterList,
                "equipment_list": rewardResult.equipment_list,
                "item_list": purchaseResult.itemList,
                "mail_arrived": getMailArrivedSync(playerId),
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
