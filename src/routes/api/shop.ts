// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerEquipmentSync, getPlayerItemSync, getPlayerSync, getSession, playerOwnsEquipmentSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerSync, getPlayerShopPurchasesMapSync, getPlayerShopPurchaseCountSync, addPlayerShopPurchaseSync } from "../../data/wdfpData";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getBossCoinShopItemsSync, getConfigSync, getEventShopItemsSync, getGenericShopItemsSync, getShopItemSync } from "../../lib/assets";
import { CharacterReward, CharacterShopItemReward, CurrencyReward, CurrencyShopItemReward, EquipmentItemReward, EquipmentItemShopItemReward, Reward, RewardType, ShopItem, ShopItemRewardType, ShopItems, ShopItemUserCostType, ShopType } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { givePlayerRewardsSync } from "../../lib/quest";
import { computeRealTimeStamina } from "../../lib/stamina";
import { clientSerializeEquipment } from "../../lib/equipment";
import CDN_GENERAL_SHOP_WHITELIST from "../../../assets/cdn_general_shop_whitelist.json";

const GENERAL_SHOP_CDN_KEYS: Set<number> = new Set(CDN_GENERAL_SHOP_WHITELIST);

interface EnhancementGroup {
    groupId: number
    items: { id: string, item: ShopItem, stage: number }[]
    equipmentId: number
}

function buildEnhancementSalesList(playerId: number, items: ShopItems): Object[] {
    if (Object.keys(items).length === 0) return []

    // Group items by groupId
    const groups = new Map<number, EnhancementGroup>()
    for (const [itemId, item] of Object.entries(items)) {
        const gid = item.groupId ?? 0
        if (!groups.has(gid)) {
            groups.set(gid, {
                groupId: gid,
                items: [],
                equipmentId: item.equipmentId ?? 0
            })
        }
        groups.get(gid)!.items.push({ id: itemId, item, stage: item.stage ?? 0 })
    }

    const result: Object[] = []

    for (const [, group] of groups) {
        // Sort by stage ascending
        group.items.sort((a, b) => a.stage - b.stage)

        const equipmentId = group.equipmentId
        const enhancementLevel = playerOwnsEquipmentSync(playerId, equipmentId)
            ? (getPlayerEquipmentSync(playerId, equipmentId)?.enhancementLevel ?? 0)
            : -1

        // Find target product: first item with enhancementMaxLevel > current enhancementLevel
        let targetItem: { id: string, item: ShopItem } | null = null
        let stockQuantity = 0
        let totalPurchaseNum = 0

        if (enhancementLevel < 0) {
            // Player doesn't have the equipment
            targetItem = group.items[0]
            stockQuantity = targetItem.item.enhancementMaxLevel ?? 0
            totalPurchaseNum = 0
        } else {
            for (const entry of group.items) {
                const maxLv = entry.item.enhancementMaxLevel ?? 0
                if (maxLv > enhancementLevel) {
                    targetItem = entry
                    stockQuantity = maxLv - enhancementLevel
                    break
                }
            }
            // If no target found (fully maxed), use last item with stock_quantity=0
            if (!targetItem) {
                targetItem = group.items[group.items.length - 1]
                stockQuantity = 0
            }
            totalPurchaseNum = enhancementLevel
        }

        // Group info: max level from last item in group
        const maxLevel = group.items[group.items.length - 1].item.enhancementMaxLevel ?? 0
        const multiStage = group.items.length > 1

        result.push({
            "shop_item_id": Number(targetItem.id),
            "stock_quantity": stockQuantity,
            "today_purchase_num": 0,
            "this_month_purchase_num": null,  // null → MsgPack nil / Option.None
            "total_purchase_num": totalPurchaseNum,
            "discount_id": null,
            "discount_rate": null,
            "discounted_price": null,
            "group_info": {
                "group_total_stock_quantity": maxLevel - totalPurchaseNum,
                "group_total_purchase_num": totalPurchaseNum,
                "multi_stage": multiStage
            },
            "shop_type": ShopType.TREASURE_EQUIPMENT
        })
    }

    return result
}

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

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/buy", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BuyBody

        const viewerId = body.viewer_id
        const shopType = body.shop_type
        const rawPurchaseAmount = body.number
        const shopItemId = body.shop_item_id
        if (isNaN(viewerId) || isNaN(shopType) || isNaN(rawPurchaseAmount) || isNaN(shopItemId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const purchaseAmount = Math.max(1, rawPurchaseAmount)

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

        // validate stock limit
        if (shopItemData.stock !== undefined && shopItemData.stock > 0) {
            const purchased = getPlayerShopPurchaseCountSync(playerId, shopItemId)
            if (purchased + purchaseAmount > shopItemData.stock) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Shop item purchase limit reached."
                })
            }
        }

        console.log(`[shop:buy] player=${playerId} shopType=${shopType} item=${shopItemId} x${purchaseAmount} before freeMana=${player.freeMana} freeVmoney=${player.freeVmoney}`)

        // keep track of various stats
        const itemList: Record<string, number> = {}
        let freeVmoney = player.freeVmoney
        let freeMana = player.freeMana
        let bondTokens = player.bondToken

        // verify user costs
        const userCost = shopItemData.userCost
        if (userCost !== undefined) {
            switch (userCost.type) {
                case ShopItemUserCostType.MANA:
                    freeMana -= (userCost.amount * purchaseAmount)
                    break;
                case ShopItemUserCostType.BEADS:
                    freeVmoney -= (userCost.amount * purchaseAmount)
                    break;
                case ShopItemUserCostType.AMITY_SCROLL:
                    bondTokens -= (userCost.amount * purchaseAmount)
            }

            if (0 > freeVmoney) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough beads to purchase shop item.`
            })
            if (0 > freeMana) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough mana to purchase shop item.`
            })
            if (0 > bondTokens) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough amity scrolls to purchase shop item.`
            })
        }

        // verify cost items
        {
            for (const cost of shopItemData.costs) {
                const itemId = cost.id
                const itemAmount = getPlayerItemSync(playerId, itemId) ?? 0
                const newItemAmount = itemAmount - (cost.amount * purchaseAmount)
                if (0 > newItemAmount) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": `Not enough of item with id ${itemId} to purchase shop item.`
                })

                itemList[itemId] = newItemAmount
            }

            // deduct cost item
            for (const [itemId, newAmount] of Object.entries(itemList)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }
        }

        // update player
        updatePlayerSync({
            id: playerId,
            freeMana: freeMana,
            freeVmoney: freeVmoney,
            bondToken: bondTokens
        })

        // Equipment enhancement shop: update equipment enhancement level
        if (shopType === ShopType.TREASURE_EQUIPMENT) {
            const equipmentId = shopItemData.equipmentId
            const targetLevel = shopItemData.enhancementMaxLevel
            if (equipmentId === undefined || targetLevel === undefined) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Enhancement item missing equipment_id or target level."
            })

            const currentEquipment = getPlayerEquipmentSync(playerId, equipmentId)
            if (currentEquipment === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Player does not own the target equipment."
            })

            // Update to target enhancement level
            const newLevel = Math.max(currentEquipment.enhancementLevel, targetLevel)
            updatePlayerEquipmentSync(playerId, equipmentId, { enhancementLevel: newLevel })
            currentEquipment.enhancementLevel = newLevel

            // Record purchase
            for (let i = 0; i < purchaseAmount; i++) {
                addPlayerShopPurchaseSync(playerId, shopItemId)
            }

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
                    "mail_arrived": false
                }
            })
        }

        // build rewards array
        const rewards: Reward[] = []
        for (const reward of shopItemData.rewards) {
            switch (reward.type) {
                case ShopItemRewardType.ITEM: {
                    const shopReward = reward as EquipmentItemShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.ITEM,
                        id: shopReward.id,
                        count: shopReward.count * purchaseAmount
                    } as EquipmentItemReward)
                    break;
                }
                case ShopItemRewardType.EXP: {
                    const shopReward = reward as CurrencyShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.EXP,
                        count: shopReward.count * purchaseAmount
                    } as CurrencyReward)
                    break;
                }
                case ShopItemRewardType.MANA:{
                    const shopReward = reward as CurrencyShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.MANA,
                        count: shopReward.count * purchaseAmount
                    } as CurrencyReward)
                    break;
                }
                case ShopItemRewardType.CHARACTER: {
                    const shopReward = reward as CharacterShopItemReward
                    for (let i = 0; i < purchaseAmount; i++) {
                        rewards.push({
                            name: "",
                            type: RewardType.CHARACTER,
                            id: shopReward.id
                        } as CharacterReward)
                    }
                    break;
                }
                case ShopItemRewardType.EQUIPMENT: {
                    const shopReward = reward as EquipmentItemShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.EQUIPMENT,
                        id: shopReward.id,
                        count: shopReward.count * purchaseAmount
                    } as EquipmentItemReward)
                    break;
                }

            }
        }
        // give rewards
        const rewardResult = givePlayerRewardsSync(playerId, rewards)

        // record purchase for stock tracking
        for (let i = 0; i < purchaseAmount; i++) {
            addPlayerShopPurchaseSync(playerId, shopItemId)
        }

        // verify DB write
        const afterPlayer = getPlayerSync(playerId)!
        console.log(`[shop:buy] after DB freeMana=${afterPlayer.freeMana} freeVmoney=${afterPlayer.freeVmoney} rewardItems=${JSON.stringify(rewardResult?.items ?? {})}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_vmoney": freeVmoney + (rewardResult?.user_info.free_vmoney ?? 0),
                    "free_mana": freeMana + (rewardResult?.user_info.free_mana ?? 0),
                    "bond_token": bondTokens,
                    "exp_pool": player.expPool + (rewardResult?.user_info.exp_pool ?? 0),
                },
                "character_list": rewardResult?.character_list ?? [],
                "equipment_list": rewardResult?.equipment_list ?? [],
                "item_list": {
                    ...itemList,
                    ...(rewardResult?.items ?? {})
                },
                "mail_arrived": false
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

        // parse shop items
        const salesList: Object[] = []

        // Load purchase history for stock tracking
        const purchasedMap = getPlayerShopPurchasesMapSync(playerId)
        const totalPurchased = Object.values(purchasedMap).reduce((a, b) => a + b, 0)
        console.log(`[shop:get_sales] player=${playerId} purchasedKeys=${Object.keys(purchasedMap).length} totalPurchased=${totalPurchased}`)

        let filteredCdnCount = 0

        // Collect enhancement shop items for group-level processing
        const enhancementItems: ShopItems = {}

        for (const [shopType, items] of Object.entries(toParseShopItems)) {
            const shopTypeNum = Number(shopType)
            for (const [itemId, item] of Object.entries(items)) {

                if (shopTypeNum === ShopType.GENERAL && !GENERAL_SHOP_CDN_KEYS.has(Number(itemId))) {
                    filteredCdnCount++
                    continue
                }

                // Filter equipment enhancement shop by category IDs
                if (shopTypeNum === ShopType.TREASURE_EQUIPMENT && equipmentEnhancementCategoryIds?.length) {
                    if (item.shopCategoryId === undefined || !equipmentEnhancementCategoryIds.includes(item.shopCategoryId)) {
                        continue
                    }
                }

                // Date filtering: only show items active at current server time
                {
                    const now = getServerDate()
                    if (item.availableFrom) {
                        const fromStr = item.availableFrom.replace(' ', 'T') + 'Z'
                        if (new Date(fromStr) > now) continue
                    }
                    if (item.availableUntil) {
                        const untilStr = item.availableUntil.replace(' ', 'T') + 'Z'
                        if (new Date(untilStr) < now) continue
                    }
                }

                if (shopTypeNum === ShopType.TREASURE_EQUIPMENT) {
                    // Collect for group-level processing later
                    enhancementItems[itemId] = item
                    continue
                }

                const purchased = purchasedMap[Number(itemId)] ?? 0
                const stock = item.stock
                const stockQuantity = stock !== undefined ? Math.max(0, stock - purchased) : -1
                salesList.push({
                    "shop_item_id": Number(itemId),
                    "stock_quantity": stockQuantity,
                    "today_purchase_num": purchased,
                    "this_month_purchase_num": purchased,
                    "total_purchase_num": purchased,
                    "group_info": {
                        "group_total_stock_quantity": stockQuantity,
                        "group_total_purchase_num": purchased,
                        "multi_stage": false
                    },
                    "shop_type": Number(shopType)
                })
            }
        }

        // Process equipment enhancement items by group
        const enhancementSales = buildEnhancementSalesList(playerId, enhancementItems)
        salesList.push(...enhancementSales)

        if (filteredCdnCount > 0) {
            console.log(`[shop] Filtered ${filteredCdnCount} general shop items not in CDN master data`)
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

        updatePlayerSync({
            id: playerId,
            stamina: afterStamina,
            staminaHealTime: new Date(),
            freeVmoney: freeVmoney - recoveryCost
        })

        console.log(`[RECOVER-STAMINA] player ${playerId}: stamina ${currentStamina}->${afterStamina} (+${actualRecovery}), freeVmoney ${freeVmoney}->${freeVmoney - recoveryCost}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "stamina": afterStamina,
                    "stamina_heal_time": getServerTime(),
                    "free_vmoney": freeVmoney - recoveryCost
                }
            }
        })
    })

    // bulk_buy — stub, returns empty (TODO: implement multi-item purchase)
    fastify.post("/bulk_buy", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })

    // get_campaign_lineup_id — stub
    fastify.post("/get_campaign_lineup_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "lineup_id": null }
        })
    })

    // set_campaign_lineup_id — stub
    fastify.post("/set_campaign_lineup_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })
}

export default routes;