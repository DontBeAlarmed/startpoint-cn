import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getQuestFromCategorySync } from "../../lib/quest-content";
import { getQuestUnlockCost } from "../../lib/quest-entry-content";
import { generateDataHeaders } from "../../utils";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge"
import { getMailArrivedSync } from "../../lib/mail-notification";
import { getDb } from "../../data/db";
import { withInventoryBatchContextWithinTransactionSync } from "../../lib/inventory";

interface UnlockBody {
    category: number
    quest_id: number
    viewer_id: number
    api_count: number
}

interface GetRecentOtherPlayerPartyBody {
    category: number
    quest_id: number
    viewer_id: number
}

type UnlockTransactionResult =
    | { ok: true, itemList: Record<string, number> }
    | { ok: false, message: string }

const routes = async (fastify: FastifyInstance) => {
    // CN 1.8.1 QuestGetRecentOtherPlayerPartyRealRemote：读取其他玩家在本 quest 的
    // 近期队伍。本服没有跨玩家队伍历史存储，返回客户端契约内的空投影，不虚构数据。
    fastify.post("/get_recent_other_player_party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetRecentOtherPlayerPartyBody
        const viewerId = body.viewer_id
        if (isNaN(viewerId) || isNaN(body.category) || isNaN(body.quest_id)) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid viewer id."
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "recent_other_player_party": [],
            }
        })
    })

    fastify.post("/unlock", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UnlockBody

        const viewerId = body.viewer_id
        const category = body.category
        const questId = body.quest_id

        if (isNaN(viewerId) || isNaN(category) || isNaN(questId)) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid viewer id."
            })
        }

        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId === null) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": "No player bound to account."
            })
        }

        const player = getPlayerSync(playerId)
        if (player === null) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": "No player data."
            })
        }

        // Look up quest data
        const questData = getQuestFromCategorySync(category, questId)
        if (questData === null) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest not found."
            })
        }

        const unlockCost = getQuestUnlockCost(questId)
        if (!unlockCost || unlockCost.itemIds.length === 0) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest does not use Once unlock items."
            })
        }

        const result = getDb().transaction((): UnlockTransactionResult => {
            const progress = getPlayerQuestProgressSync(playerId)
            const sectionProg = progress[String(category)] ?? []
            const existing = sectionProg.find(entry => entry.questId === questId)
            if (existing?.unlocked) {
                return { ok: false, message: "Quest already unlocked." }
            }

            const itemCosts = new Map<number, number>()
            for (let i = 0; i < unlockCost.itemIds.length; i++) {
                const itemId = unlockCost.itemIds[i]
                const cost = unlockCost.itemCounts[i] ?? 1
                itemCosts.set(itemId, (itemCosts.get(itemId) ?? 0) + cost)
            }

            const inventoryResult = withInventoryBatchContextWithinTransactionSync({
                playerId,
                preloadItemIds: [...itemCosts.keys()],
            }, inventory => {
                for (const [itemId, cost] of itemCosts) {
                    if (inventory.read(itemId).afterAmount < cost) {
                        return {
                            ok: false as const,
                            message: `Not enough of item ${itemId} to unlock quest.`,
                        }
                    }
                }

                const updatedItems: Record<string, number> = {}
                for (const [itemId, cost] of itemCosts) {
                    updatedItems[String(itemId)] = inventory.deduct(itemId, cost).afterAmount
                }
                inventory.flush()
                return { ok: true as const, itemList: updatedItems }
            })
            if (!inventoryResult.ok) return inventoryResult

            if (existing) {
                updatePlayerQuestProgressSync(playerId, category, { questId, unlocked: true })
            } else {
                insertPlayerQuestProgressSync(playerId, category, { questId, finished: false, unlocked: true })
            }
            return inventoryResult
        })()
        if (!result.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": mergeCommonResponseFragments([{
                "item_list": result.itemList,
                "mail_arrived": getMailArrivedSync(playerId),
            }])
        })
    })
}

export default routes
